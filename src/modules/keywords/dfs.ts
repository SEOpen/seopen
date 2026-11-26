import "server-only";
import { cache } from "react";
import { dfsPost, peekCache, stableStringify, taskResults, type DfsModule, type DfsResponse } from "@/lib/dataforseo/client";

/**
 * A paid DataForSEO request described up front, so a page can show what it would cost
 * before spending anything. Shared by the keywords and domains modules.
 */
export interface DfsSpec {
  path: string;
  task: Record<string, unknown>;
  ttlSeconds: number;
  /** Worst-case cost in USD, shown on Run buttons. The customer is never charged more for this call. */
  estUsd: number;
  module: DfsModule;
  /** Retries after a server error, when not the client's default. 0 for a request that can run minutes. */
  retries?: number;
}

export type Loaded<R> =
  /** `chargedUsd`: what this load charged the workspace, 0 for a response it already paid for. */
  | { state: "ready"; results: R[]; cached: boolean; fetchedAt: Date | null; chargedUsd: number }
  /** Not in the cache and the page wasn't asked to spend. */
  | { state: "idle"; estUsd: number };

/** Who a load is for: the workspace pays (and must have paid for a cached response); the project is noted in the ledger. */
export interface LoadOpts {
  run: boolean;
  workspaceId: number;
  projectId?: number | null;
}

/** Cached response for a spec that's free for this workspace, or null. Never spends. */
export async function peek<R>(spec: DfsSpec, workspaceId: number): Promise<{ res: DfsResponse<R>; createdAt: Date } | null> {
  const hit = await peekCache<R>(workspaceId, "POST", spec.path, [spec.task], spec.ttlSeconds);
  return hit ? { res: hit.response, createdAt: hit.createdAt } : null;
}

/**
 * Loads a spec from the cache, or from the API when `run` is set. Pages pass `run`
 * only after the user clicked a button that showed the cost.
 */
export async function load<R>(spec: DfsSpec, opts: LoadOpts): Promise<Loaded<R>> {
  const hit = await peek<R>(spec, opts.workspaceId);
  if (hit) return { state: "ready", results: taskResults(hit.res), cached: true, fetchedAt: hit.createdAt, chargedUsd: 0 };
  if (!opts.run) return { state: "idle", estUsd: spec.estUsd };
  const res = await dfsPost<R>(spec.path, [spec.task], {
    workspaceId: opts.workspaceId,
    module: spec.module,
    projectId: opts.projectId ?? null,
    ttlSeconds: spec.ttlSeconds,
    // Reserve what the Run button showed, so the credits check holds before the call.
    estimateUsd: spec.estUsd,
    // And charge no more than it showed, whatever DataForSEO bills.
    maxChargeUsd: spec.estUsd,
    ...(spec.retries === undefined ? {} : { retries: spec.retries }),
  });
  // A fresh call is charged its real cost up to the price shown; a response another workspace paid for, its original cost.
  const chargedUsd = res.cached ? 0 : (res.chargedUsd ?? Math.min(res.cost ?? 0, spec.estUsd));
  return { state: "ready", results: taskResults(res), cached: !!res.cached, fetchedAt: new Date(), chargedUsd };
}

const loadMemo = cache((specJson: string, run: boolean, workspaceId: number, projectId: number | null) =>
  load<unknown>(JSON.parse(specJson) as DfsSpec, { run, workspaceId, projectId }),
);

/**
 * `load`, memoized per request. Use it whenever two sections of a page may need the same
 * spec, so concurrent cache misses can't pay for the same call twice.
 */
export function loadOnce<R>(spec: DfsSpec, opts: LoadOpts): Promise<Loaded<R>> {
  return loadMemo(stableStringify(spec), opts.run, opts.workspaceId, opts.projectId ?? null) as Promise<Loaded<R>>;
}

/** Sum of estimated costs for the specs that aren't free for this workspace yet. */
export async function pendingCost(specs: DfsSpec[], workspaceId: number): Promise<number> {
  const hits = await Promise.all(specs.map((s) => peek(s, workspaceId)));
  return specs.reduce((sum, s, i) => (hits[i] ? sum : sum + s.estUsd), 0);
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Runs a data load and captures its error, so pages can render <ApiError> without JSX inside try/catch. */
export async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}
