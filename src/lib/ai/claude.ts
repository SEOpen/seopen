import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { db } from "@/db";
import { apiLedger } from "@/db/schema";
import { ledgerSource } from "@/lib/billing/context";
import { reserveSpend } from "@/lib/billing/spend";
import { release, settle } from "@/lib/billing/usage";
import { claudeCostUsd } from "./pricing";

/**
 * Server-side Claude calls. One client, reading
 * ANTHROPIC_API_KEY. Every call reserves its estimate against the workspace's ceiling first, like
 * a DataForSEO call, and records what it cost in `api_ledger` with `provider = 'anthropic'`.
 */

export const CLAUDE_MODEL = "claude-opus-5-5";

export const claudeConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client: Anthropic | undefined;
const claude = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 }));

export interface ClaudeCall {
  workspaceId: number;
  projectId?: number | null;
  /** The module the ledger files it under, e.g. "setup". */
  module: string;
  /** Reserved against the workspace's ceiling before the call; the real cost settles it. */
  estimateUsd: number;
  /** Whether it also spends research credits. Either way it counts against the ceiling. */
  research?: boolean;
  /**
   * What a research call holds against research credits, when that's less than `estimateUsd`: the
   * price the user was quoted. The ceiling still holds the whole estimate. Defaults to the estimate.
   */
  researchEstimateUsd?: number;
  params: Omit<MessageCreateParamsNonStreaming, "model" | "betas" | "fallbacks">;
}

/**
 * One Messages call on Claude Opus 5.5 with the server-side fallback for refusals. Throws
 * SpendRefusedError before calling when the workspace can't spend the estimate, and the SDK's
 * errors after; the caller decides what a failure means. The response's `stop_reason` is the
 * caller's to check.
 */
export async function callClaude(call: ClaudeCall) {
  const reservation = await reserveSpend(call.workspaceId, call.estimateUsd, call.research ?? false, call.module, call.researchEstimateUsd);
  let response;
  try {
    response = await claude().beta.messages.create({
      ...call.params,
      model: CLAUDE_MODEL,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    // An API error isn't billed; record the attempt so Admin shows it.
    await release(reservation);
    await record(call, 0, err instanceof Anthropic.APIError ? (err.status ?? 0) : 0);
    throw err;
  }
  const costUsd = claudeCostUsd(CLAUDE_MODEL, response.usage);
  await record(call, costUsd, 200);
  await settle(reservation, { chargedUsd: costUsd, costUsd });
  return { response, costUsd };
}

async function record(call: ClaudeCall, costUsd: number, statusCode: number) {
  await db.insert(apiLedger).values({
    workspaceId: call.workspaceId,
    provider: "anthropic",
    endpoint: "messages",
    module: call.module,
    projectId: call.projectId ?? null,
    costUsd,
    chargedUsd: costUsd,
    tasks: 1,
    statusCode,
    source: ledgerSource(),
  });
}
