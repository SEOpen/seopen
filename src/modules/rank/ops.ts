import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { rankKeywords, rankRuns } from "@/db/schema/rank";
import { analyticsEnabled, track } from "@/lib/analytics/server";
import { canTrackKeywords, isInternal, keywordUnits, limitsFor } from "@/lib/billing/gates";
import { keywordUnitsInUse, loadBillingWorkspace, projectActionRefusal } from "@/lib/billing/workspace";
import { enqueue } from "@/lib/jobs/boss";
import { OpError, plural, refused, type Actor, type OpOptions } from "@/lib/ops";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { maxCheckCost } from "./metrics";
import { capNewKeywords, normalizeKeywords, repeatedKeywords, withoutOperators } from "./parse";
import { createRun, getSettings } from "./tracker";

/** Rank tracking changes shared by the Server Actions and the MCP server (see `src/lib/ops`). */

export const MAX_KEYWORDS_PER_ADD = 500;

const OPERATORS_REFUSED = "Rank tracking can't check keywords with search operators such as site: or intitle:. Add the keyword without them.";

export type Device = "desktop" | "mobile";

export interface TrackedKeywords {
  dryRun: boolean;
  /** Keywords new to the project (this many count against the plan, with any turned back on). */
  added: number;
  /** Already tracked on this device: tags merged, paused ones turned back on. */
  already: number;
  /** Over the per-add limit. */
  skipped: number;
  /** Entries, as given, that repeat another in other case or spacing: tracked once. */
  repeated: string[];
  /** What one keyword counts as against the plan at the project's daily depth (2 at depth 20). */
  unitsPerKeyword: number;
  /** Plan keyword units this add takes: new keywords and paused ones turned back on. */
  units: number;
  /** Units the plan has left after this add, or null when it sets no limit. */
  unitsLeft: number | null;
  message: string;
}

/**
 * Tracks keywords on one device with optional tags: lowercased and deduped, and keywords already
 * tracked get the tags merged (and are turned back on if paused). `from` names a saved list in the
 * message. Daily checks start from the next scheduled run.
 */
export async function trackKeywordsOp(
  scope: ProjectScope,
  actor: Actor,
  input: { keywords: string[]; tags?: string[]; device?: Device; from?: string },
  opts: OpOptions = {},
): Promise<TrackedKeywords> {
  const locked = await projectActionRefusal(scope);
  if (locked) throw refused(locked);
  const { keywords: all, operators } = withoutOperators(normalizeKeywords(input.keywords));
  if (!all.length) throw new OpError(operators.length ? OPERATORS_REFUSED : "No keywords to add.");
  const tags = input.tags ?? [];
  const device = input.device ?? "desktop";
  const existing = await db
    .select({ keyword: rankKeywords.keyword, active: rankKeywords.active })
    .from(rankKeywords)
    .where(
      and(
        eq(rankKeywords.workspaceId, scope.workspaceId),
        eq(rankKeywords.projectId, scope.projectId),
        eq(rankKeywords.device, device),
        inArray(rankKeywords.keyword, all),
      ),
    );
  const { keywords, added, skipped } = capNewKeywords(all, new Set(existing.map((e) => e.keyword)), MAX_KEYWORDS_PER_ADD);
  // The plan counts active keywords: new ones and paused ones this turns back on.
  const inactive = new Set(existing.filter((e) => !e.active).map((e) => e.keyword));
  const activating = added + keywords.filter((k) => inactive.has(k)).length;
  // keywordGate's check, done here so the answer can say what the add uses and what's left.
  const ws = await loadBillingWorkspace(scope.workspaceId);
  const [inUse, settings] = await Promise.all([keywordUnitsInUse(ws.id), getSettings(scope)]);
  if (activating > 0) {
    const gate = canTrackKeywords(ws, inUse, activating, settings.dailyDepth);
    if (!gate.ok) throw new OpError(gate.message);
  }
  const unitsPerKeyword = keywordUnits(settings.dailyDepth);
  const units = activating * unitsPerKeyword;
  const limit = limitsFor(ws).keywords;
  const unitsLeft = Number.isFinite(limit) ? Math.max(0, limit - inUse - units) : null;
  const repeated = repeatedKeywords(input.keywords);
  const already = keywords.length - added;
  if (!opts.dryRun) {
    await db
      .insert(rankKeywords)
      .values(keywords.map((keyword) => ({ ...scope, keyword, tags, device })))
      .onConflictDoUpdate({
        target: [rankKeywords.projectId, rankKeywords.keyword, rankKeywords.device],
        set: {
          active: true,
          tags: sql`array(select distinct unnest(${rankKeywords.tags} || excluded.tags) order by 1)`,
        },
      });
    if (added) {
      await enqueue("rank.volumes", scope, { singletonKey: `rank.volumes:${scope.projectId}` });
      // Only this add's keywords are on the project: rank tracking was just set up, and checks follow.
      if (analyticsEnabled() && (await db.$count(rankKeywords, inScope(rankKeywords, scope))) === added) {
        track(actor.userId, "module_activated", { module: "rank", project_id: scope.projectId, keywords: added }, { workspaceId: scope.workspaceId });
      }
    }
  }
  const parts = [`${opts.dryRun ? "Would add" : "Added"} ${plural(added, "keyword")}${input.from ?? ""}`];
  if (already) parts.push(`${already} already tracked${tags.length ? " (tags merged)" : ""}`);
  if (skipped) parts.push(`${skipped} over the ${MAX_KEYWORDS_PER_ADD}-per-add limit; add again for the rest`);
  if (operators.length) parts.push(`${plural(operators.length, "keyword")} with search operators such as site: left out`);
  if (repeated.length) parts.push(`${plural(repeated.length, "duplicate")} in other case or spacing counted once: ${repeated.map((r) => `“${r.trim()}”`).join(", ")}`);
  return { dryRun: !!opts.dryRun, added, already, skipped, repeated, unitsPerKeyword, units, unitsLeft, message: `${parts.join(" · ")}.` };
}

/**
 * The project now searches from somewhere else: its search volumes are for the old place, so they
 * reload. If the job can't be queued, tomorrow's check picks them up.
 */
export async function rankPlaceChanged(scope: ProjectScope): Promise<void> {
  await db.update(rankKeywords).set({ volumeUpdatedAt: null }).where(inScope(rankKeywords, scope));
  await enqueue("rank.volumes", scope, { singletonKey: `rank.volumes:${scope.projectId}` }).catch((e) => console.error("[rank] queueing volumes", e));
}

export const ALREADY_RUNNING = "A check is already running for this project. Results appear as they land; try again once it finishes.";

export interface StartedCheck {
  dryRun: boolean;
  /** Null on a dry run. */
  runId: number | null;
  keywords: number;
  depth: number;
  aiOverview: boolean;
  /** The most it can cost in dollars, rechecks included, only for workspaces that see dollar costs. Customers' checks are covered by the plan. */
  maxCostUsd: number | null;
  message: string;
}

/**
 * "Check now": one run for every active keyword. `deep` uses the sweep depth and loads AI
 * Overviews. Refuses while another run is in flight; the one-active-run index makes that hold under
 * double clicks too.
 */
export async function startRankCheckOp(scope: ProjectScope, input: { deep?: boolean }, opts: OpOptions = {}): Promise<StartedCheck> {
  const refusal = await projectActionRefusal(scope, { paid: true, quiet: opts.dryRun });
  if (refusal) throw refused(refusal);
  const deep = !!input.deep;
  const s = await getSettings(scope);
  const depth = deep ? s.sweepDepth : s.dailyDepth;
  const keywords = await db.$count(rankKeywords, and(inScope(rankKeywords, scope), eq(rankKeywords.active, true)));
  if (!keywords) throw new OpError("This project tracks no keywords yet. Add some first.");
  const ws = await loadBillingWorkspace(scope.workspaceId);
  const maxCostUsd = isInternal(ws) ? maxCheckCost(keywords, depth, deep) : null;
  const what = `${deep ? "a deep check" : "a check"} of ${plural(keywords, "keyword")} at depth ${depth}`;
  if (opts.dryRun) return { dryRun: true, runId: null, keywords, depth, aiOverview: deep, maxCostUsd, message: `Would start ${what}.` };
  const run = await createRun(scope, "manual", { depth, aiOverview: deep });
  if (!run) throw new OpError(ALREADY_RUNNING);
  try {
    await enqueue("rank.check", { ...scope, runId: run.id });
  } catch (e) {
    // Free the slot so the next click can try again.
    await db
      .update(rankRuns)
      .set({ status: "failed", error: "Could not queue the check", finishedAt: new Date() })
      .where(and(eq(rankRuns.id, run.id), eq(rankRuns.workspaceId, scope.workspaceId)));
    throw e;
  }
  return { dryRun: false, runId: run.id, keywords, depth, aiOverview: deep, maxCostUsd, message: `Started ${what}. Results arrive over the next few minutes.` };
}
