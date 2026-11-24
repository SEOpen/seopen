import { and, desc, eq, inArray, max } from "drizzle-orm";
import { db } from "@/db";
import { backlinksDomainDecisions, backlinksSnapshots, projects } from "@/db/schema";
import { failedCheck, type CheckFailure } from "@/lib/check-failure";
import { callFailed, dfsPost, firstResult, lastCalls, peekCache, TTL, type DfsResponse } from "@/lib/dataforseo/client";
import { plainCallFailure } from "@/lib/dataforseo/failure-copy";
import type { ProjectScope } from "@/lib/workspace";
import { dofollowShare, estimateCostUsd, timeseriesWindow } from "./logic";
import type {
  AnchorItem,
  BacklinkItem,
  BacklinksSummary,
  IntersectionItem,
  ItemsResult,
  NewLostItem,
  ReferringDomainItem,
} from "./types";

/** What a fetch cost: 0 and cached=true when it came from the local cache. */
export interface FetchMeta {
  cached: boolean;
  costUsd: number;
  /** List-price estimate for a fresh fetch, for labels. */
  estimateUsd: number;
  /** When a cached response was first fetched, where the read knows. */
  fetchedAt: Date | null;
}

export interface Fetched<T> {
  data: T;
  meta: FetchMeta;
}

/** Returned instead of data when the response isn't cached and the caller didn't ask to spend. */
export interface Pending {
  pending: true;
  /** List-price estimate for loading it. */
  estimateUsd: number;
}

export const isPending = (r: object): r is Pending => "pending" in r;

/** Sum of the estimates of the results that still need a paid call. */
export function pendingUsd(results: object[]): number {
  return results.reduce<number>((n, r) => (isPending(r) ? n + r.estimateUsd : n), 0);
}

interface CallOpts {
  /** Workspace the call is made for: its cap, ledger and cache. */
  workspaceId: number;
  projectId?: number | null;
  /** Bypass the cache and pay for a fresh response. */
  force?: boolean;
  /**
   * Allow a paid call when the response isn't cached. Defaults to true (jobs, actions);
   * pages pass `run` only after the user clicked a button that showed the cost, and
   * otherwise get a cached response for free or `Pending`.
   */
  run?: boolean;
}

/**
 * POST one backlinks task, honoring `run`: a cache-only read unless the caller may spend. The
 * peek only returns entries this workspace can read for free (see the DataForSEO client). A paid
 * call reserves the list price of `rows`, the most it can return, and charges no more than that.
 */
async function call<R>(path: string, task: object, ttlSeconds: number, rows: number, opts: CallOpts): Promise<Called<R> | null> {
  if (!opts.force) {
    const hit = await peekCache<R>(opts.workspaceId, "POST", path, [task]);
    if (hit) return { ...hit.response, cached: true, fetchedAt: hit.createdAt };
    if (opts.run === false) return null;
  }
  const maxChargeUsd = estimateCostUsd(rows);
  const res = await dfsPost<R>(path, [task], {
    module: "backlinks",
    workspaceId: opts.workspaceId,
    projectId: opts.projectId,
    ttlSeconds,
    force: opts.force,
    estimateUsd: estimateCostUsd(rows),
    // The price shown (and MCP's max_credits) holds: above it SEOpen absorbs the difference, as keywords' load does.
    maxChargeUsd,
  });
  return { ...res, maxChargeUsd };
}

/** A backlinks response, with when a saved one was fetched and the most a fresh one was charged. */
type Called<R> = DfsResponse<R> & { fetchedAt?: Date; maxChargeUsd?: number };

/**
 * What this workspace was charged: a fresh call's cost, capped at the price `call()` showed, or a
 * shared cache entry another workspace paid for.
 */
function meta(res: Called<unknown>, rows: number): FetchMeta {
  const fresh = res.cached ? 0 : Math.min(res.tasks?.[0]?.cost ?? res.cost ?? 0, res.maxChargeUsd ?? Infinity);
  return { cached: !!res.cached, costUsd: res.chargedUsd ?? fresh, estimateUsd: estimateCostUsd(rows), fetchedAt: res.fetchedAt ?? null };
}

export const LIST_LIMIT = 500;

/** The call behind a snapshot, weekly or from a refresh. */
const SUMMARY_PATH = "backlinks/summary/live";

/** Summary KPIs (cached 24 h). Also files the numbers as a snapshot when the target is a project's domain. */
export async function getSummary(target: string, opts: CallOpts): Promise<Fetched<BacklinksSummary | null> | Pending> {
  const res = await call<BacklinksSummary>(
    SUMMARY_PATH,
    { target, include_subdomains: true, backlinks_status_type: "live", internal_list_limit: 10 },
    TTL.day,
    1,
    opts,
  );
  if (!res) return { pending: true, estimateUsd: estimateCostUsd(1) };
  const data = firstResult(res);
  if (data) await snapshotForProjects(opts.workspaceId, target, data, res);
  return { data, meta: meta(res, 1) };
}

/**
 * File a snapshot for every project of this workspace whose domain is `target`, under the day the
 * numbers were fetched. Fresh numbers replace that day's reading. A saved response only fills a gap:
 * reading it again isn't a new reading, so it can't make old numbers look like today's.
 */
async function snapshotForProjects(workspaceId: number, target: string, s: BacklinksSummary, res: { cached?: boolean; fetchedAt?: Date }) {
  const owners = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.domain, target), eq(projects.archived, false)));
  if (!owners.length) return;
  const date = (res.fetchedAt ?? new Date()).toISOString().slice(0, 10);
  const values = {
    target,
    backlinks: s.backlinks ?? 0,
    referringDomains: s.referring_domains ?? 0,
    referringMainDomains: s.referring_main_domains,
    rank: s.rank,
    spamScore: s.backlinks_spam_score,
    nofollowBacklinks: s.referring_links_attributes?.nofollow ?? 0,
    brokenBacklinks: s.broken_backlinks,
    dofollowShare: dofollowShare(s),
  };
  for (const { id } of owners) {
    const insert = db.insert(backlinksSnapshots).values({ workspaceId, projectId: id, date, ...values });
    await (res.cached
      ? insert.onConflictDoNothing({ target: [backlinksSnapshots.projectId, backlinksSnapshots.date] })
      : insert.onConflictDoUpdate({ target: [backlinksSnapshots.projectId, backlinksSnapshots.date], set: { ...values, createdAt: new Date() } }));
  }
}

/** Monthly new/lost backlinks and referring domains over the last 12 months (cached 7 days). */
export async function getNewLost(target: string, opts: CallOpts): Promise<Fetched<NewLostItem[]> | Pending> {
  const res = await call<ItemsResult<NewLostItem>>(
    "backlinks/timeseries_new_lost_summary/live",
    { target, ...timeseriesWindow(new Date()), group_range: "month", include_subdomains: true },
    TTL.week,
    13,
    opts,
  );
  if (!res) return { pending: true, estimateUsd: estimateCostUsd(13) };
  return { data: firstResult(res)?.items ?? [], meta: meta(res, 13) };
}

export type DomainStatus = "live" | "lost";

export async function getReferringDomains(
  target: string,
  opts: CallOpts & { status?: DomainStatus; limit?: number },
): Promise<Fetched<{ total: number; items: ReferringDomainItem[] }> | Pending> {
  const limit = opts.limit ?? LIST_LIMIT;
  const res = await call<ItemsResult<ReferringDomainItem>>(
    "backlinks/referring_domains/live",
    { target, limit, order_by: ["rank,desc"], backlinks_status_type: opts.status ?? "live", include_subdomains: true },
    TTL.week,
    limit,
    { ...opts, force: false },
  );
  if (!res) return { pending: true, estimateUsd: estimateCostUsd(limit) };
  const r = firstResult(res);
  return { data: { total: r?.total_count ?? 0, items: r?.items ?? [] }, meta: meta(res, r?.items_count ?? limit) };
}

export type LinkStatus = "live" | "new" | "lost";

export async function getBacklinks(
  target: string,
  opts: CallOpts & { status?: LinkStatus; onePerDomain?: boolean; dofollowOnly?: boolean; limit?: number },
): Promise<Fetched<{ total: number; items: BacklinkItem[] }> | Pending> {
  const limit = opts.limit ?? LIST_LIMIT;
  const conditions: unknown[] = [];
  if (opts.status === "new") conditions.push(["is_new", "=", true]);
  if (opts.dofollowOnly) conditions.push(["dofollow", "=", true]);
  const filters = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : [conditions[0], "and", conditions[1]];
  const res = await call<ItemsResult<BacklinkItem>>(
    "backlinks/backlinks/live",
    {
      target,
      mode: opts.onePerDomain ? "one_per_domain" : "as_is",
      limit,
      order_by: ["rank,desc"],
      backlinks_status_type: opts.status === "lost" ? "lost" : "live",
      include_subdomains: true,
      filters,
    },
    TTL.week,
    limit,
    { ...opts, force: false },
  );
  if (!res) return { pending: true, estimateUsd: estimateCostUsd(limit) };
  const r = firstResult(res);
  return { data: { total: r?.total_count ?? 0, items: r?.items ?? [] }, meta: meta(res, r?.items_count ?? limit) };
}

export async function getAnchors(target: string, opts: CallOpts): Promise<Fetched<{ total: number; items: AnchorItem[] }> | Pending> {
  const res = await call<ItemsResult<AnchorItem>>(
    "backlinks/anchors/live",
    { target, limit: LIST_LIMIT, order_by: ["backlinks,desc"], backlinks_status_type: "live", include_subdomains: true },
    TTL.week,
    LIST_LIMIT,
    { ...opts, force: false },
  );
  if (!res) return { pending: true, estimateUsd: estimateCostUsd(LIST_LIMIT) };
  const r = firstResult(res);
  return { data: { total: r?.total_count ?? 0, items: r?.items ?? [] }, meta: meta(res, r?.items_count ?? LIST_LIMIT) };
}

export const GAP_LIMIT = 200;

/**
 * Domains linking to `competitor` but not to `target`: a single-target domain_intersection
 * call with our domain in exclude_targets (cached 7 days). One call per competitor, reading at most
 * GAP_LIMIT of them; `total` is how many there are.
 */
export async function getCompetitorGap(competitor: string, target: string, opts: CallOpts): Promise<(Fetched<IntersectionItem[]> & { total: number }) | Pending> {
  const res = await call<ItemsResult<IntersectionItem>>(
    "backlinks/domain_intersection/live",
    {
      targets: { "1": competitor },
      exclude_targets: [target],
      limit: GAP_LIMIT,
      order_by: ["1.rank,desc"],
      backlinks_status_type: "live",
      include_subdomains: true,
    },
    TTL.week,
    GAP_LIMIT,
    { ...opts, force: false },
  );
  if (!res) return { pending: true, estimateUsd: estimateCostUsd(GAP_LIMIT) };
  const r = firstResult(res);
  const items = r?.items ?? [];
  return { data: items, total: r?.total_count ?? items.length, meta: meta(res, r?.items_count ?? GAP_LIMIT) };
}

// ---------------------------------------------------------------------------
// Stored data (free)

export async function listSnapshots(scope: ProjectScope, limit = 26) {
  const rows = await db
    .select()
    .from(backlinksSnapshots)
    .where(and(eq(backlinksSnapshots.workspaceId, scope.workspaceId), eq(backlinksSnapshots.projectId, scope.projectId)))
    .orderBy(desc(backlinksSnapshots.date))
    .limit(limit);
  return rows.reverse();
}

/**
 * Projects whose newest summary call failed after their newest snapshot was filed: the weekly snapshot, or
 * a refresh, couldn't run, so the stored numbers are older than the last try. The ledger is where that call
 * is recorded. Database reads only.
 */
export async function snapshotFailures(workspaceId: number, projectIds: number[], timeZone: string): Promise<Map<number, CheckFailure>> {
  if (!projectIds.length) return new Map();
  const [calls, filed] = await Promise.all([
    lastCalls(workspaceId, projectIds, "backlinks", [SUMMARY_PATH]),
    db
      .select({ projectId: backlinksSnapshots.projectId, at: max(backlinksSnapshots.createdAt) })
      .from(backlinksSnapshots)
      .where(and(eq(backlinksSnapshots.workspaceId, workspaceId), inArray(backlinksSnapshots.projectId, projectIds)))
      .groupBy(backlinksSnapshots.projectId),
  ]);
  const newest = new Map(filed.map((r) => [r.projectId, r.at]));
  const out = new Map<number, CheckFailure>();
  for (const [projectId, call] of calls) {
    const at = newest.get(projectId);
    if (!callFailed(call) || (at && at >= call.at)) continue;
    const plain = plainCallFailure(call.statusCode, call.endpoint);
    out.set(projectId, failedCheck({ noun: "check", at: call.at, timeZone, reason: plain.message, retry: plain.retry, next: { label: "View", href: "/backlinks" } }));
  }
  return out;
}

export async function listDecisions(scope: ProjectScope) {
  return db
    .select()
    .from(backlinksDomainDecisions)
    .where(and(eq(backlinksDomainDecisions.workspaceId, scope.workspaceId), eq(backlinksDomainDecisions.projectId, scope.projectId)));
}
