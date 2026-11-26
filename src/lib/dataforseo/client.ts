import { createHash } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiCache, apiCacheAccess, apiLedger } from "@/db/schema";
import { countsAsResearch, ledgerSource } from "@/lib/billing/context";
import { SpendRefusedError } from "@/lib/billing/errors";
import { recordJobPause } from "@/lib/billing/pauses";
import { reserveSpend, spendState } from "@/lib/billing/spend";
import { addUsage, release, RESEARCH_MODULES, settle, type Exec, type Reservation } from "@/lib/billing/usage";
import { env } from "@/lib/env";
import { isDailyLimit, isPaymentRequired, noteDailyLimit, notePaymentRequired } from "./balance";
import { CLAIM_WAIT_MS, claimKey, FETCH_TIMEOUT_MS, releaseClaim, renewClaim, waitForClaim } from "./claims";

export { BudgetExceededError, SpendRefusedError } from "@/lib/billing/errors";

/**
 * The only way SEOpen talks to DataForSEO. Every call goes through here so that
 * responses are cached, every paid call lands in the ledger, and each workspace's monthly cap holds.
 *
 * Every call names the workspace it is made for. The response cache is shared between workspaces
 * only for public market data (`sharedCacheEndpoint`); a shared hit is free only for a workspace
 * that paid for that response, and any other workspace is charged the original call's cost
 * against its cap.
 *
 * Billing (src/lib/billing): before a paid call the workspace's plan is checked and the call's
 * estimate is reserved atomically against its monthly ceiling, its research credits (domains,
 * keywords, backlinks and Local calls, and an AI run started by hand) and the platform cap; the real cost settles it afterwards. A
 * refusal throws SpendRefusedError, a BudgetExceededError. Inside a background job the refusal
 * also pauses that job with a banner (src/lib/billing/pauses.ts).
 */

const BASE_URL = "https://api.dataforseo.com/v3/";
/** Reserved for a paid call that doesn't say what it will cost. */
export const DEFAULT_ESTIMATE_USD = 0.02;

export type DfsModule = "core" | "domains" | "keywords" | "rank" | "audit" | "backlinks" | "ai" | "local" | "tools";

/**
 * Every paid call names the workspace it is made for. Only a free call (`free: true`) may leave it
 * out, e.g. the pollers' account-wide tasks_ready.
 */
export type DfsCallOptions = DfsCallBase &
  (
    | {
        /** Workspace the call is made for: its cap is checked, its ledger charged, its cache used. */
        workspaceId: number;
        /** Free endpoints (appendix, tasks_ready, task_get) skip the budget check and the ledger. */
        free?: boolean;
      }
    | { workspaceId?: undefined; free: true }
  );

interface DfsCallBase {
  /** Module making the call; shows up in the spend breakdown. */
  module: DfsModule;
  projectId?: number | null;
  /** Seconds to cache the response. 0 disables caching (default for task_post/task_get). */
  ttlSeconds?: number;
  /** Skip the cache read (the fresh response is still cached). */
  force?: boolean;
  /**
   * Retries after an HTTP 5xx. Defaults to 2, or 0 for task_post: a 5xx there may still have
   * created a paid task, so retrying could pay twice. 429s are always retried (nothing was created).
   */
  retries?: number;
  /**
   * Expected cost of this call, reserved against the workspace's ceiling before the call
   * (DEFAULT_ESTIMATE_USD when unset). The call is refused if it doesn't fit.
   */
  estimateUsd?: number;
  /**
   * The price the customer was shown for this call: they're never charged more. If DataForSEO
   * bills more, SEOpen absorbs the difference: the ledger and the platform cap keep the real cost.
   */
  maxChargeUsd?: number;
  /**
   * Whether the call counts as research credits. Defaults to true for the domains, keywords,
   * backlinks and local modules, unless the call runs under `onPlanMeter` (scheduled snapshots),
   * and to true for any module under `onResearchMeter` (an AI run started by hand).
   */
  research?: boolean;
}

export interface DfsTask<R = unknown> {
  id: string;
  status_code: number;
  status_message: string;
  cost: number;
  result_count: number;
  path: string[];
  data: Record<string, unknown>;
  result: R[] | null;
}

export interface DfsResponse<R = unknown> {
  status_code: number;
  status_message: string;
  cost: number;
  tasks_count: number;
  tasks_error: number;
  tasks: DfsTask<R>[];
  /**
   * True when this response is one the workspace already paid for, served from the local cache.
   * A shared response another workspace paid for is false: it's charged like a fresh lookup, and
   * saying "cached" would tell this workspace that someone else looked the same thing up.
   */
  cached?: boolean;
  /** What the workspace's cap was charged for a cached response another workspace paid for. */
  chargedUsd?: number;
}

export class DataForSEOError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "DataForSEOError";
  }
}

/**
 * Another call is still fetching the same lookup from DataForSEO after a whole wait for it
 * (src/lib/dataforseo/claims.ts). Nothing was fetched or charged, so trying again in a minute reads
 * that call's answer.
 */
export class LookupInFlightError extends DataForSEOError {
  constructor(endpoint: string) {
    super("Another request is still fetching the same lookup from DataForSEO, so this one didn't fetch it again", 0, endpoint);
    this.name = "LookupInFlightError";
  }
}

/** JSON.stringify with sorted object keys, so equal requests hash equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cacheKey(method: string, path: string, body?: unknown): string {
  return createHash("sha256")
    .update(`${method} ${normalizePath(path)} ${body === undefined ? "" : stableStringify(body)}`)
    .digest("hex");
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/^v3\//, "");
}

/**
 * Endpoints whose responses are public market data, safe to share between workspaces: Labs
 * domain and keyword data, Backlinks, live SERPs, Google Ads volume and LLM Mentions. It's an
 * allowlist, so a new endpoint isn't shared by accident. Everything else (On-Page crawls and
 * Lighthouse, LLM responses and scraper prompts, Standard-queue tasks) is cached per workspace.
 */
const SHARED_CACHE_PREFIXES = [
  "dataforseo_labs/",
  "backlinks/",
  "keywords_data/google_ads/",
  "serp/google/organic/live/",
  "ai_optimization/llm_mentions/",
];

export function sharedCacheEndpoint(path: string): boolean {
  const endpoint = normalizePath(path);
  if (/(^|\/)(task_post|task_get|tasks_ready)(\/|$)/.test(endpoint)) return false;
  return SHARED_CACHE_PREFIXES.some((p) => endpoint.startsWith(p));
}

/** The cache row key for a request made by a workspace: shared endpoints share one key, others get the workspace's own. */
export function workspaceCacheKey(workspaceId: number, method: string, path: string, body?: unknown): string {
  const key = cacheKey(method, path, body);
  return sharedCacheEndpoint(path) ? key : `w${workspaceId}:${key}`;
}

function authHeader(): string {
  const { DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD } = env();
  if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
    throw new DataForSEOError("DataForSEO credentials are missing: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD aren't set", 0, "");
  }
  return `Basic ${Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString("base64")}`;
}

/**
 * The workspace's hard monthly ceiling: its plan's (the trial's $3, a paid plan's full-use cost plus
 * 10%), lowered by its own cap (the owner sets theirs on /admin/spend). The internal plan's is its own cap, or
 * DATAFORSEO_MONTHLY_CAP_USD when it hasn't set one.
 */
export async function monthlyCapUsd(workspaceId: number): Promise<number> {
  return (await spendState(workspaceId)).ceilingUsd;
}

/** What the workspace's cap has been charged this calendar month (including shared cache hits). */
export async function monthToDateSpendUsd(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${apiLedger.chargedUsd}), 0)` })
    .from(apiLedger)
    .where(and(eq(apiLedger.workspaceId, workspaceId), gte(apiLedger.createdAt, sql`date_trunc('month', now())`)));
  return Number(row?.total ?? 0);
}

/** A project's newest call to an endpoint, as the ledger kept it. A `statusCode` of 20000 worked; anything else failed. */
export interface LastCall {
  at: Date;
  statusCode: number;
  endpoint: string;
}

/**
 * Each project's newest call from `module` to one of `endpoints`. The ledger keeps every call DataForSEO
 * answered with its status, failed or not, so it's where a scheduled call nobody saw fail is recorded. A
 * saved response the workspace already paid for makes no call and adds nothing.
 */
export async function lastCalls(workspaceId: number, projectIds: number[], module: DfsModule, endpoints: string[]): Promise<Map<number, LastCall>> {
  if (!projectIds.length) return new Map();
  const rows = await db
    .selectDistinctOn([apiLedger.projectId], { projectId: apiLedger.projectId, at: apiLedger.createdAt, statusCode: apiLedger.statusCode, endpoint: apiLedger.endpoint })
    .from(apiLedger)
    .where(
      and(
        eq(apiLedger.workspaceId, workspaceId),
        eq(apiLedger.module, module),
        inArray(apiLedger.projectId, projectIds),
        inArray(apiLedger.endpoint, endpoints),
        isNotNull(apiLedger.statusCode),
      ),
    )
    .orderBy(apiLedger.projectId, desc(apiLedger.createdAt), desc(apiLedger.id));
  return new Map(rows.map((r) => [r.projectId!, { at: r.at, statusCode: r.statusCode!, endpoint: r.endpoint }]));
}

/** Whether a call the ledger kept failed. */
export const callFailed = (c: LastCall | undefined): c is LastCall => !!c && c.statusCode !== 20000;

/** Whether a call counts toward research credits. */
function isResearch(opts: DfsCallOptions): boolean {
  if (opts.research !== undefined) return opts.research;
  return countsAsResearch(opts.module, RESEARCH_MODULES);
}

/**
 * Reserves a paid call's estimate, or throws SpendRefusedError. A refusal inside a background
 * job pauses that job for the workspace, so the app shows a banner instead of a daily failure.
 */
async function reserveFor(workspaceId: number, estimateUsd: number, opts: DfsCallOptions): Promise<Reservation> {
  try {
    return await reserveSpend(workspaceId, estimateUsd, isResearch(opts), opts.module);
  } catch (err) {
    if (err instanceof SpendRefusedError && err.code !== "free_plan") await recordJobPause(err).catch((e) => console.error("[billing] couldn't record a paused job", e));
    throw err;
  }
}

/**
 * `createdAt` is when the row was written, which the claim logic compares. `shownAt` is the time a
 * page may show for it: for a shared row, when this workspace paid for it, so a hit another
 * workspace fetched earlier never shows that workspace's time.
 */
type CacheHit<R> = { response: DfsResponse<R>; createdAt: Date; shownAt: Date; paid: boolean };

/**
 * Whether a response is worth keeping: the request and every task in it worked, or found nothing
 * (40102). DataForSEO can answer 20000 with `tasks_error: 0` while a task inside failed (40101
 * "Internal SE Server Error" on a Live SERP, Nov 16 2026), and keeping that answer served the same
 * failure to every retry until it expired, a week for a brief's top 10.
 */
export function cacheable(json: Pick<DfsResponse, "status_code" | "tasks_error" | "tasks">): boolean {
  return json.status_code === 20000 && !json.tasks_error && (json.tasks ?? []).every((t) => t.status_code === 20000 || t.status_code === 40102);
}

/**
 * `maxAgeSeconds` is the life the reading call asks for. A row lives as long as the call that wrote it
 * asked, and two calls can share a key with different lives, so a row older than the reader's own
 * life is a miss for that reader: a day-long lookup is never answered from a week-old row.
 */
async function readCache<R>(workspaceId: number, key: string, shared: boolean, maxAgeSeconds?: number): Promise<CacheHit<R> | null> {
  const [row] = await db
    .select({ response: apiCache.response, createdAt: apiCache.createdAt, payer: apiCacheAccess.workspaceId, paidAt: apiCacheAccess.paidAt })
    .from(apiCache)
    .leftJoin(apiCacheAccess, and(eq(apiCacheAccess.key, apiCache.key), eq(apiCacheAccess.workspaceId, workspaceId)))
    .where(and(eq(apiCache.key, key), gt(apiCache.expiresAt, new Date())));
  // Saved before `cacheable` checked each task: a failed task is a miss, so the next call fetches again.
  if (!row || !cacheable(row.response as DfsResponse)) return null;
  if (maxAgeSeconds !== undefined && Date.now() - row.createdAt.getTime() > maxAgeSeconds * 1000) return null;
  // A per-workspace key is the workspace's own by construction.
  const paid = !shared || row.payer !== null;
  const shownAt = shared && row.paidAt ? row.paidAt : row.createdAt;
  return { response: { ...(row.response as DfsResponse<R>), cached: true }, createdAt: row.createdAt, shownAt, paid };
}

/**
 * The cached response for a request, only when it's free for this workspace: a page uses this to
 * render cached data without spending. A shared response another workspace paid for returns null,
 * so the page offers "Run" at the normal price instead of revealing that someone looked it up.
 * `createdAt` is the reader's own time (CacheHit's `shownAt`), never another workspace's fetch.
 * `maxAgeSeconds` is the life the paid call for the same request would ask for (`ttlSeconds`), so
 * a page shows nothing older than that call would accept.
 */
export async function peekCache<R>(
  workspaceId: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  maxAgeSeconds?: number,
): Promise<{ response: DfsResponse<R>; createdAt: Date } | null> {
  const hit = await readCache<R>(workspaceId, workspaceCacheKey(workspaceId, method, path, body), sharedCacheEndpoint(path), maxAgeSeconds);
  return hit?.paid ? { response: hit.response, createdAt: hit.shownAt } : null;
}

/** When the row for a cache key was written, fresh or expired. A change during a call means another call saved it first. */
async function cacheWrittenAt(key: string): Promise<Date | null> {
  const [row] = await db.select({ createdAt: apiCache.createdAt }).from(apiCache).where(eq(apiCache.key, key));
  return row?.createdAt ?? null;
}

/**
 * Saves a fresh response and returns false. Returns true, saving nothing, when this workspace paid
 * for a newer one while this call ran (a double click, a reload mid-lookup): one lookup is charged once.
 */
async function writeCache(workspaceId: number, key: string, endpoint: string, response: unknown, ttlSeconds: number, writtenBefore: Date | null): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return db.transaction(async (tx) => {
    // Two calls finishing together: the lock makes the second one see the first one's row.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const [row] = await tx
      .select({ createdAt: apiCache.createdAt, expiresAt: apiCache.expiresAt, response: apiCache.response, payer: apiCacheAccess.workspaceId })
      .from(apiCache)
      .leftJoin(apiCacheAccess, and(eq(apiCacheAccess.key, apiCache.key), eq(apiCacheAccess.workspaceId, workspaceId)))
      .where(eq(apiCache.key, key));
    if (row && row.payer !== null && row.createdAt.getTime() !== writtenBefore?.getTime()) return true;
    await tx
      .insert(apiCache)
      .values({ key, endpoint, response, expiresAt })
      .onConflictDoUpdate({ target: apiCache.key, set: { response, expiresAt, createdAt: new Date() } });
    // After expiry, or over a saved failure (which reads as a miss), everyone pays again: only the
    // workspace that just paid has the new response free. A refresh of a live answer keeps the
    // others' access, though: dropping it would show them that another workspace refreshed (their
    // free view turning back into Run). They keep it for the new row's life, one TTL at most, and
    // their shown time stays the time they paid.
    const live = row && row.expiresAt > new Date() && cacheable(row.response as DfsResponse);
    if (!live) await tx.delete(apiCacheAccess).where(eq(apiCacheAccess.key, key));
    await tx
      .insert(apiCacheAccess)
      .values({ key, workspaceId })
      .onConflictDoUpdate({ target: [apiCacheAccess.key, apiCacheAccess.workspaceId], set: { paidAt: new Date() } });
    return false;
  });
}

/** What a call's real cost charges the workspace: never more than the price it was shown. */
function chargeFor(endpoint: string, costUsd: number, opts: DfsCallOptions): number {
  if (opts.maxChargeUsd === undefined || costUsd <= opts.maxChargeUsd) return costUsd;
  console.error(`[billing] ${endpoint} cost $${costUsd}, more than the $${opts.maxChargeUsd} shown. Charged the price shown: check its estimate.`);
  return opts.maxChargeUsd;
}

/**
 * A shared cache hit this workspace hasn't paid for: charge its cap the original call's cost
 * (nothing is spent at DataForSEO) and remember that it has now paid for this response. It comes
 * back as `cached: false`, the same as a fresh lookup, so nothing downstream (a "fetched" note,
 * an MCP reply, a free tool's "saved answer") can show that another workspace paid for it. The
 * next hit is this workspace's own and comes back `cached: true`.
 */
async function chargeCacheHit<R>(key: string, endpoint: string, hit: CacheHit<R>, opts: DfsCallOptions & { workspaceId: number }): Promise<DfsResponse<R>> {
  const chargedUsd = chargeFor(endpoint, Number(hit.response.cost ?? 0), opts);
  const reservation = chargedUsd > 0 ? await reserveFor(opts.workspaceId, chargedUsd, opts) : null;
  let charged = false;
  try {
    await db.transaction(async (tx) => {
      // Two requests racing for the same hit: only the one that records the access is charged.
      const [first] = await tx
        .insert(apiCacheAccess)
        .values({ key, workspaceId: opts.workspaceId })
        .onConflictDoNothing()
        .returning({ key: apiCacheAccess.key });
      if (!first) return;
      await tx.insert(apiLedger).values({
        workspaceId: opts.workspaceId,
        endpoint,
        module: opts.module,
        projectId: opts.projectId ?? null,
        costUsd: 0,
        chargedUsd,
        tasks: hit.response.tasks_count ?? 0,
        statusCode: hit.response.status_code,
        source: ledgerSource(),
      });
      charged = true;
    });
  } finally {
    if (reservation) await settle(reservation, { chargedUsd: charged ? chargedUsd : 0, costUsd: 0 });
  }
  return { ...hit.response, cached: false, chargedUsd };
}

/** task_post can create a paid task even when it answers 5xx, so it isn't retried by default. */
export function defaultServerRetries(endpoint: string): number {
  return /(^|\/)task_post$/.test(normalizePath(endpoint)) ? 0 : 2;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<R>(method: "GET" | "POST", path: string, body: unknown, opts: DfsCallOptions) {
  const workspaceId = opts.workspaceId;
  if (workspaceId === undefined ? !opts.free : !Number.isInteger(workspaceId)) throw new Error("A paid DataForSEO call needs a workspace");
  const endpoint = normalizePath(path);
  // A workspace-less (free, account-wide) call is never cached.
  const ttl = workspaceId === undefined ? 0 : (opts.ttlSeconds ?? 0);
  const shared = sharedCacheEndpoint(endpoint);
  const key = workspaceCacheKey(workspaceId ?? 0, method, endpoint, body);

  if (workspaceId !== undefined && ttl > 0 && !opts.force) {
    const hit = await readCache<R>(workspaceId, key, shared, ttl);
    if (hit) return serveHit(key, endpoint, hit, { ...opts, workspaceId });
  }
  // One call per cache key fetches at a time; the others wait for its answer (claims.ts).
  let claim: string | null = null;
  if (workspaceId !== undefined && ttl > 0) {
    const claimed = await claimOrWait<R>(key, endpoint, shared, { ...opts, workspaceId });
    if ("response" in claimed) return claimed.response;
    claim = claimed.token;
  }
  try {
    const reservation = opts.free ? null : await reserveFor(workspaceId!, opts.estimateUsd ?? DEFAULT_ESTIMATE_USD, opts);
    let cacheTo: CacheTo | null = null;
    try {
      if (workspaceId !== undefined && claim) cacheTo = { workspaceId, key, ttl, writtenBefore: await cacheWrittenAt(key), claim };
      return await send<R>(method, endpoint, body, opts, reservation, cacheTo);
    } catch (err) {
      // send() settles once DataForSEO has answered; a network error or a throw before that releases it.
      if (reservation && !settled.has(reservation)) await release(reservation);
      throw err;
    }
  } finally {
    // Saved or failed, the next call can go: it reads the saved answer, or tries again.
    if (claim) await releaseClaim(key, claim).catch((err) => console.error(`[dataforseo] couldn't release the claim on ${endpoint}`, err));
  }
}

type CacheTo = { workspaceId: number; key: string; ttl: number; writtenBefore: Date | null; claim: string };

/** A cached response: free when this workspace paid for it, charged as a shared hit when it didn't. */
async function serveHit<R>(key: string, endpoint: string, hit: CacheHit<R>, opts: DfsCallOptions & { workspaceId: number }): Promise<DfsResponse<R>> {
  return hit.paid ? hit.response : chargeCacheHit(key, endpoint, hit, opts);
}

/**
 * Claims the key for this call, or waits while another call holds it and serves that call's answer
 * from the cache. The call that fetched is charged as before and a waiter as a cache hit: free in
 * the workspace that paid (a double click, a reload mid-lookup), the original price in any other.
 * Nobody fetches while another call's claim is live, so DataForSEO is paid once.
 *
 * A forced call skips a saved answer, but not one saved while it waited: that one is newer than the
 * click that forced it. A wait that outlasts CLAIM_WAIT_MS throws LookupInFlightError instead of
 * fetching beside the call that holds the claim.
 */
async function claimOrWait<R>(
  key: string,
  endpoint: string,
  shared: boolean,
  opts: DfsCallOptions & { workspaceId: number },
): Promise<{ token: string } | { response: DfsResponse<R> }> {
  const savedBefore = opts.force ? await cacheWrittenAt(key) : null;
  const usable = (hit: CacheHit<R> | null): hit is CacheHit<R> => !!hit && (!opts.force || hit.createdAt.getTime() !== savedBefore?.getTime());
  const deadline = Date.now() + CLAIM_WAIT_MS;
  let waited = false;
  for (;;) {
    const token = await claimKey(key);
    if (token) {
      // The call before this one may have saved its answer just before letting go of the key.
      const hit = opts.force && !waited ? null : await readCache<R>(opts.workspaceId, key, shared, opts.ttlSeconds);
      if (!usable(hit)) return { token };
      await releaseClaim(key, token);
      return { response: await serveHit(key, endpoint, hit, opts) };
    }
    waited = true;
    if ((await waitForClaim(key, deadline)) === "busy") throw new LookupInFlightError(endpoint);
    const hit = await readCache<R>(opts.workspaceId, key, shared, opts.ttlSeconds);
    if (usable(hit)) return { response: await serveHit(key, endpoint, hit, opts) };
    // No answer was saved (its fetch failed, or its claim lapsed): claim the key and fetch.
  }
}

const settled = new WeakSet<Reservation>();

async function send<R>(
  method: "GET" | "POST",
  endpoint: string,
  body: unknown,
  opts: DfsCallOptions,
  reservation: Reservation | null,
  cacheTo: CacheTo | null,
): Promise<DfsResponse<R>> {
  const serverRetries = opts.retries ?? defaultServerRetries(endpoint);
  let res: Response;
  for (let attempt = 0, serverErrors = 0; ; attempt++) {
    // A retry keeps the key claimed for one more request (claims.ts).
    if (attempt > 0 && cacheTo) await renewClaim(cacheTo.key, cacheTo.claim).catch((err) => console.error(`[dataforseo] couldn't renew the claim on ${endpoint}`, err));
    res = await fetch(BASE_URL + endpoint, {
      method,
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const retryable = res.status === 429 ? attempt < 2 : res.status >= 500 && serverErrors++ < serverRetries;
    if (!retryable) break;
    await sleep(1000 * 2 ** attempt);
  }
  if (!res.ok) {
    if (isPaymentRequired(res.status)) await notePaymentRequired(endpoint);
    await recordLedger(endpoint, opts, 0, 0, 0, res.status);
    if (reservation) {
      settled.add(reservation);
      await release(reservation);
    }
    throw new DataForSEOError(`DataForSEO HTTP ${res.status} on ${endpoint}`, res.status, endpoint);
  }

  const json = (await res.json()) as DfsResponse<R>;
  const cost = Number(json.cost ?? 0);
  // Saved before charging, because saving is what tells whether this workspace has already paid.
  let alreadyPaid = false;
  if (cacheTo && cacheable(json)) {
    const { workspaceId, key, ttl, writtenBefore } = cacheTo;
    alreadyPaid = await writeCache(workspaceId, key, endpoint, json, ttl, writtenBefore).catch((err) => {
      console.error(`[dataforseo] couldn't save the response from ${endpoint}`, err);
      return false;
    });
  }
  const chargedUsd = alreadyPaid ? 0 : chargeFor(endpoint, cost, opts);
  await recordLedger(endpoint, opts, cost, chargedUsd, json.tasks_count ?? 0, json.status_code);
  if (reservation) {
    settled.add(reservation);
    await settle(reservation, { chargedUsd, costUsd: cost });
  }
  // 40203 can come back for the whole call or for single tasks in it.
  if (isDailyLimit(json.status_code) || json.tasks?.some((t) => isDailyLimit(t?.status_code))) await noteDailyLimit(endpoint);

  if (json.status_code !== 20000) {
    if (isPaymentRequired(json.status_code)) await notePaymentRequired(endpoint);
    throw new DataForSEOError(json.status_message, json.status_code, endpoint);
  }
  return json;
}

async function recordLedger(
  endpoint: string,
  opts: DfsCallOptions,
  costUsd: number,
  chargedUsd: number,
  tasks: number,
  statusCode: number,
) {
  // task_get and summary responses repeat the price of the task they belong to, which was
  // already recorded at task_post. Counting it again would double the month's spend.
  if (opts.free || opts.workspaceId === undefined) return;
  await db.insert(apiLedger).values({
    workspaceId: opts.workspaceId,
    endpoint,
    module: opts.module,
    projectId: opts.projectId ?? null,
    costUsd,
    chargedUsd,
    tasks,
    statusCode,
    source: ledgerSource(),
  });
}

/**
 * Ledger correction outside a call, e.g. a negative delta for a crawl refund when fewer
 * pages were crawled than were charged up front. Counts toward the workspace's month-to-date spend.
 * Pass a transaction as `x` to record it together with the change it accounts for.
 */
export async function recordLedgerAdjustment(adj: {
  workspaceId: number;
  endpoint: string;
  module: DfsModule;
  projectId?: number | null;
  deltaUsd: number;
}, x: Exec & Pick<typeof db, "insert"> = db) {
  if (!Number.isFinite(adj.deltaUsd) || adj.deltaUsd === 0) return;
  await addUsage(
    adj.workspaceId,
    {
      chargedUsd: adj.deltaUsd,
      costUsd: adj.deltaUsd,
      research: countsAsResearch(adj.module, RESEARCH_MODULES),
    },
    x,
  );
  await x.insert(apiLedger).values({
    workspaceId: adj.workspaceId,
    endpoint: normalizePath(adj.endpoint),
    module: adj.module,
    projectId: adj.projectId ?? null,
    costUsd: adj.deltaUsd,
    chargedUsd: adj.deltaUsd,
    tasks: 0,
    statusCode: null,
    source: ledgerSource(),
  });
}

/** POST an array of tasks, e.g. dfsPost("dataforseo_labs/google/ranked_keywords/live", [{...}], {...}). */
export function dfsPost<R = unknown>(path: string, tasks: object[], opts: DfsCallOptions) {
  return request<R>("POST", path, tasks, opts);
}

/** GET, for task_get, tasks_ready and appendix endpoints. */
export function dfsGet<R = unknown>(path: string, opts: DfsCallOptions) {
  return request<R>("GET", path, undefined, opts);
}

/**
 * Results of a single-task response. Throws if the task failed, so callers
 * don't silently render an empty table. 40102 ("No Search Results") returns [].
 */
export function taskResults<R>(response: DfsResponse<R>, index = 0): R[] {
  const task = response.tasks?.[index];
  if (!task) throw new DataForSEOError("DataForSEO returned no task", 0, "");
  if (task.status_code === 40102) return [];
  if (task.status_code !== 20000) {
    throw new DataForSEOError(task.status_message, task.status_code, task.path?.join("/") ?? "");
  }
  return task.result ?? [];
}

/** First result object of a single-task response, or null. */
export function firstResult<R>(response: DfsResponse<R>, index = 0): R | null {
  return taskResults(response, index)[0] ?? null;
}

/** Common cache lifetimes, in seconds. */
export const TTL = {
  hour: 3600,
  day: 86_400,
  week: 7 * 86_400,
  month: 30 * 86_400,
} as const;
