import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { aiBrandAliases } from "@/db/schema/ai";
import { track } from "@/lib/analytics/server";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { trackedLocation } from "@/lib/dataforseo/locations";
import { OpError, type Actor } from "@/lib/ops";
import { addCompetitorsOp, projectCity } from "@/lib/ops/projects";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { hostOf } from "@/modules/ai/detect";
import { addPromptsOp, startAiRunOp } from "@/modules/ai/ops";
import { PLATFORM_KEYS } from "@/modules/ai/platforms";
import { startCrawlOp } from "@/modules/audit/ops";
import { rankPlaceChanged, startRankCheckOp, trackKeywordsOp } from "@/modules/rank/ops";
import { MAX_COMPETITOR_NAME, MAX_SETUP_KEYWORDS, PROPOSAL_LIMITS } from "./propose";

/**
 * Applies what the user ticked on the setup checklist, through the
 * same ops as the app's buttons, so plan limits, read-only projects and spend gates all hold. Each
 * step stands alone: a refusal stops that step, and the result says what was and wasn't done.
 */

export const selectionSchema = z.object({
  competitors: z.array(z.string().trim().min(3).max(253)).max(PROPOSAL_LIMITS.competitors),
  /** The business names a lookup gave for some of those competitors, by domain. Kept as the competitor's name in AI visibility. */
  competitorNames: z.record(z.string().trim().min(3).max(253), z.string().trim().min(2).max(MAX_COMPETITOR_NAME)).optional(),
  keywords: z
    .array(z.object({ keyword: z.string().trim().min(1).max(200), tag: z.string().trim().max(60).nullable() }))
    .max(MAX_SETUP_KEYWORDS),
  prompts: z
    .array(z.object({ prompt: z.string().trim().min(3).max(500), keyword: z.string().trim().max(200), topic: z.string().trim().max(60).nullable() }))
    .max(PROPOSAL_LIMITS.prompts),
  checks: z.object({ rank: z.boolean(), ai: z.boolean(), audit: z.boolean() }),
  /** A city for rank tracking to search from (a DataForSEO location code), checked against the project's country when applied. */
  city: z.number().int().positive().nullable().optional(),
});

export type SetupSelection = z.infer<typeof selectionSchema>;

export type SetupStep = "city" | "competitors" | "keywords" | "prompts" | "rank" | "ai" | "audit";

export interface StepResult {
  step: SetupStep;
  ok: boolean;
  message: string;
}

async function step(name: SetupStep, out: StepResult[], run: () => Promise<string>) {
  try {
    out.push({ step: name, ok: true, message: await run() });
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    out.push({ step: name, ok: false, message: e.message });
  }
}

export async function applySetupOp(project: Project, actor: Actor, raw: SetupSelection): Promise<StepResult[]> {
  const sel = selectionSchema.parse(raw);
  const scope = projectScope(project);
  const out: StepResult[] = [];

  // First, so the keywords and the first check below search from it.
  if (sel.city != null) {
    await step("city", out, async () => {
      const refusal = await projectActionRefusal(scope);
      if (refusal) throw new OpError(refusal.message, refusal);
      const city = await projectCity({ locationCode: project.locationCode, cityCode: sel.city }, project);
      await db
        .update(projects)
        .set(city)
        .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
      if (trackedLocation({ locationCode: project.locationCode, cityCode: city.cityCode }) !== trackedLocation(project)) await rankPlaceChanged(scope);
      return `Rankings are searched from ${city.cityName}.`;
    });
  }

  if (sel.competitors.length) {
    await step("competitors", out, async () => {
      const added = await addCompetitorsOp(scope, sel.competitors);
      // A name the lookup gave becomes the competitor's name in AI visibility, which otherwise reads it off the domain ("Harlowseo").
      const names = Object.entries(sel.competitorNames ?? {}).flatMap(([domain, alias]) => {
        const match = added.added.find((d) => d === hostOf(domain));
        return match ? [{ ...scope, domain: match, alias }] : [];
      });
      if (names.length) await db.insert(aiBrandAliases).values(names).onConflictDoNothing();
      return added.message;
    });
  }

  if (sel.keywords.length) {
    await step("keywords", out, async () => {
      // One add per tag, so each keyword keeps its own.
      const byTag = new Map<string | null, string[]>();
      for (const k of sel.keywords) byTag.set(k.tag, [...(byTag.get(k.tag) ?? []), k.keyword]);
      const messages: string[] = [];
      for (const [tag, keywords] of byTag) {
        messages.push((await trackKeywordsOp(scope, actor, { keywords, tags: tag ? [tag] : undefined, from: "setup" })).message);
      }
      return messages.length === 1 ? messages[0] : `Added keywords under ${byTag.size} tags.`;
    });
  }

  if (sel.prompts.length) {
    await step("prompts", out, async () => {
      const items = sel.prompts.map((p) => ({ prompt: p.prompt, keyword: p.keyword || null, source: "suggested" as const, topic: p.topic }));
      return (await addPromptsOp(scope, actor, items, PLATFORM_KEYS)).message;
    });
  }

  if (sel.checks.rank) await step("rank", out, async () => (await startRankCheckOp(scope, {})).message);
  if (sel.checks.ai) await step("ai", out, async () => (await startAiRunOp(scope)).message);
  if (sel.checks.audit) await step("audit", out, async () => (await startCrawlOp(project, actor, {})).message);

  track(
    actor.userId,
    "setup_applied",
    {
      project_id: scope.projectId,
      city: sel.city != null,
      competitors: sel.competitors.length,
      keywords: sel.keywords.length,
      prompts: sel.prompts.length,
      checks: Object.values(sel.checks).filter(Boolean).length,
      failed_steps: out.filter((r) => !r.ok).length,
    },
    { workspaceId: scope.workspaceId },
  );
  return out;
}
