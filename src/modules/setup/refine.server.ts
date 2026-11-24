import "server-only";
import { createHash } from "node:crypto";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { and, count, eq, gt, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiCache, apiLedger } from "@/db/schema";
import { CLAUDE_MODEL, callClaude, claudeConfigured } from "@/lib/ai/claude";
import { SpendRefusedError } from "@/lib/billing/errors";
import { isInternal, limitsFor, type BillingWorkspace } from "@/lib/billing/gates";
import { applyRefinement, refinementSchema, refinePrompt, REVIEW_CACHE_DAYS, reviewQuote, REVIEW_QUOTE_USD, reviewSpendsCredits, type Refinement, type ReviewQuote } from "./refine";
import type { Proposal, SetupInput } from "./propose";

/**
 * Whether guided setup asks Claude. The owner's workspace only for now: the privacy page doesn't
 * yet say that a site's homepage text and keywords go to Anthropic. Naming
 * Anthropic there is what opens this.
 */
export const claudeSetupOpen = (ws: BillingWorkspace) => claudeConfigured() && isInternal(ws);

/**
 * Reserved against the ceiling before the call; research credits hold only the quoted price
 * (REVIEW_QUOTE_USD). Measured cost replaces both in the ledger.
 */
const ESTIMATE_USD = 0.4;
const MAX_TOKENS = 16_000;

/** Claude reviews this workspace has had this month, any project, deleted ones included. */
async function reviewsThisMonth(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(apiLedger)
    .where(and(eq(apiLedger.workspaceId, workspaceId), eq(apiLedger.provider, "anthropic"), eq(apiLedger.module, "setup"), eq(apiLedger.statusCode, 200), gte(apiLedger.createdAt, sql`date_trunc('month', now())`)));
  return row?.n ?? 0;
}

/** The review the price line shows, or null where guided setup doesn't ask Claude. */
export async function setupReviewQuote(ws: BillingWorkspace & { id: number }): Promise<ReviewQuote | null> {
  if (!claudeSetupOpen(ws)) return null;
  return reviewQuote(await reviewsThisMonth(ws.id), limitsFor(ws).projects);
}

/**
 * Where a review's answer is kept: per workspace, and by the exact request, so the same inputs
 * (reopening the setup, a second click) reuse it without a call, while a changed answer, newly
 * tracked items or a new model ask again. Not in api_cache_access: only this workspace reads it.
 */
const cacheKey = (workspaceId: number, system: string, user: string) =>
  `anthropic:setup:${workspaceId}:${createHash("sha256").update(`${CLAUDE_MODEL}\n${system}\n${user}`).digest("hex")}`;

async function cachedRefinement(key: string): Promise<Refinement | null> {
  const [row] = await db.select({ response: apiCache.response }).from(apiCache).where(and(eq(apiCache.key, key), gt(apiCache.expiresAt, new Date())));
  const parsed = row ? refinementSchema.safeParse(row.response) : null;
  return parsed?.success ? parsed.data : null;
}

async function saveRefinement(key: string, refinement: Refinement): Promise<void> {
  const expiresAt = new Date(Date.now() + REVIEW_CACHE_DAYS * 86_400_000);
  await db
    .insert(apiCache)
    .values({ key, endpoint: "anthropic/messages", response: refinement, expiresAt })
    .onConflictDoUpdate({ target: apiCache.key, set: { response: refinement, expiresAt, createdAt: new Date() } });
}

export type Refined = { proposal: Proposal & { summary: string | null }; costUsd: number } | { error: string };

/**
 * Claude's review of the plain proposal, or why there isn't one. Never throws for a Claude
 * failure: the caller shows the plain proposal with the reason instead.
 */
export async function refineProposal(ws: BillingWorkspace, scope: { workspaceId: number; projectId: number }, input: SetupInput, plain: Proposal): Promise<Refined> {
  const { system, user } = refinePrompt(input, plain);
  const key = cacheKey(scope.workspaceId, system, user);
  try {
    const cached = await cachedRefinement(key);
    if (cached) return refined(input, plain, cached, 0);
    const research = reviewSpendsCredits(await reviewsThisMonth(scope.workspaceId), limitsFor(ws).projects);
    const { response, costUsd } = await callClaude({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      module: "setup",
      estimateUsd: ESTIMATE_USD,
      research,
      researchEstimateUsd: REVIEW_QUOTE_USD,
      params: {
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort: "medium", format: betaZodOutputFormat(refinementSchema) },
      },
    });
    if (response.stop_reason === "refusal") return { error: "Claude declined to review this site, so this is the plain proposal." };
    if (response.stop_reason === "max_tokens") return { error: "Claude's review was cut short, so this is the plain proposal." };
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = refinementSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { error: "Claude's review couldn't be read, so this is the plain proposal." };
    // Paid for already: a failed save only means the next identical request asks again.
    await saveRefinement(key, parsed.data).catch((e) => console.error("[setup] couldn't save Claude's review:", e instanceof Error ? e.message : e));
    return refined(input, plain, parsed.data, costUsd);
  } catch (err) {
    if (err instanceof SpendRefusedError) return { error: `${err.message} This is the plain proposal.` };
    console.error("[setup] Claude review failed:", err instanceof Error ? err.message : err);
    return { error: "Claude's review didn't run, so this is the plain proposal." };
  }
}

function refined(input: SetupInput, plain: Proposal, refinement: Refinement, costUsd: number): Refined {
  const proposal = applyRefinement(input, plain, refinement);
  if (!proposal.competitors.length && plain.competitors.length) proposal.notes = [...proposal.notes, "Claude didn't find a real rival among Google's results, so add the competitors you know."];
  return { proposal, costUsd };
}
