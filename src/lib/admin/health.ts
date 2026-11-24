import "server-only";
import { and, eq, gte, inArray, isNotNull, max, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { ga4LandingDaily, googleAccounts, googleSyncState, plausibleAccounts, posthogAccounts, projects, umamiAccounts, workspaceJobPauses, workspaces, workspaceUsage } from "@/db/schema";
import { findSpendAlerts, type SpendAlert } from "@/lib/billing/alerts";
import { limitsFor } from "@/lib/billing/gates";
import { balanceProblems, readBalanceState, type BalanceProblem } from "@/lib/dataforseo/balance";
import { workerHealth, type WorkerProblem } from "@/lib/jobs/worker-watch";
import { isUndefinedTable } from "@/modules/rank/db-errors";
import { admin } from "@/plan-policy/admin";
import type { AdminStopped } from "@/lib/billing/policy";
import { jobErrorLine, type StoredJobError } from "./job-error";
import { problemSync, syncLabel, type SyncProblem } from "./sync-problem";

/**
 * Everything the owner should look at across workspaces: a worker that stopped, a low DataForSEO balance, failed jobs, syncs
 * that stopped, broken connections, paused jobs, spend near a ceiling or over an alert, and workspaces that can't spend.
 * Read-only; every row names its workspace so the Health page can link to it.
 */

/** Spend this month at or above this share of a workspace's ceiling is reported. */
export const NEAR_CEILING_SHARE = 0.8;

export type FailedJob = {
  name: string;
  workspaceId: number | null;
  workspace: string | null;
  n: number;
  last: string;
  error: string | null;
};

/**
 * Failed pg-boss jobs in the last `days`, grouped by queue and workspace, with the latest error as one
 * line: a query failure shows its table and the database's own error, never the SQL and its params.
 */
export async function failedJobs(days = 7, workspaceId?: number): Promise<FailedJob[]> {
  try {
    const rows = await db.execute<Omit<FailedJob, "error"> & { latest: StoredJobError | null }>(sql`
      select j.name,
             (j.data->>'workspaceId')::int as "workspaceId",
             w.name as workspace,
             count(*)::int as n,
             max(coalesce(j.completed_on, j.started_on, j.created_on))::text as last,
             (array_agg(jsonb_build_object('message', j.output->>'message', 'cause', j.output#>>'{cause,message}') order by coalesce(j.completed_on, j.created_on) desc))[1] as latest
      from pgboss.job j
      left join workspaces w on w.id = (j.data->>'workspaceId')::int
      where j.state = 'failed'
        and j.created_on > now() - make_interval(days => ${days})
        ${workspaceId === undefined ? sql`` : sql`and j.data->>'workspaceId' = ${String(workspaceId)}`}
      group by j.name, (j.data->>'workspaceId')::int, w.name
      order by last desc`);
    return [...rows].map(({ latest, ...r }) => ({ ...r, error: latest ? jobErrorLine(latest) : null }));
  } catch (e) {
    // pgboss.job exists only once the worker has started against this database. Any other failure surfaces.
    if (isUndefinedTable(e)) return [];
    throw e;
  }
}

export interface SyncRow extends SyncProblem {
  workspaceId: number;
  workspace: string;
  projectId: number;
  domain: string;
  source: string;
  sourceLabel: string;
  lastSuccessAt: string | null;
}

/** Search Console, GA4, PostHog, Plausible and Umami syncs that errored, need a reconnect, haven't succeeded lately, or work while their data stopped arriving. */
export async function syncProblems(workspaceId?: number, now = new Date()): Promise<SyncRow[]> {
  const rows = await db
    .select({
      workspaceId: googleSyncState.workspaceId,
      workspace: workspaces.name,
      projectId: googleSyncState.projectId,
      domain: projects.domain,
      source: googleSyncState.source,
      status: googleSyncState.status,
      message: googleSyncState.message,
      lastError: googleSyncState.lastError,
      lastRunAt: googleSyncState.lastRunAt,
      lastSuccessAt: googleSyncState.lastSuccessAt,
      latestDate: googleSyncState.latestDate,
      ga4Property: projects.ga4Property,
      posthogProject: projects.posthogProject,
      plausibleSite: projects.plausibleSite,
      umamiSite: projects.umamiSite,
    })
    .from(googleSyncState)
    .innerJoin(projects, eq(projects.id, googleSyncState.projectId))
    .innerJoin(workspaces, eq(workspaces.id, googleSyncState.workspaceId))
    .where(and(eq(projects.archived, false), workspaceId === undefined ? undefined : eq(googleSyncState.workspaceId, workspaceId)));
  // The source a project reads now: an older one's row stays behind after a switch, and the table holds only the new one's data.
  const analytics = (r: (typeof rows)[number]) => (r.umamiSite ? "umami" : r.plausibleSite ? "plausible" : r.posthogProject ? "posthog" : r.ga4Property ? "ga4" : null);
  const reading = rows.filter((r) => r.source === analytics(r)).map((r) => r.projectId);
  const newest = reading.length
    ? new Map(
        (
          await db
            .select({ projectId: ga4LandingDaily.projectId, newest: max(ga4LandingDaily.date) })
            .from(ga4LandingDaily)
            .where(inArray(ga4LandingDaily.projectId, reading))
            .groupBy(ga4LandingDaily.projectId)
        ).map((n) => [n.projectId, n.newest]),
      )
    : new Map<number, string | null>();
  return rows.flatMap((r) => {
    const problem = problemSync({ ...r, newestData: r.source === analytics(r) ? newest.get(r.projectId) : null }, now);
    if (!problem) return [];
    return [
      {
        workspaceId: r.workspaceId,
        workspace: r.workspace,
        projectId: r.projectId,
        domain: r.domain,
        source: r.source,
        sourceLabel: syncLabel(r.source),
        lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
        ...problem,
      },
    ];
  });
}

export interface ConnectionProblem {
  workspaceId: number;
  workspace: string;
  service: "Google" | "PostHog" | "Plausible" | "Umami";
  account: string;
  status: string;
  error: string | null;
}

/** Google, PostHog, Plausible and Umami connections that aren't active or reported an error on their last refresh. */
export async function connectionProblems(workspaceId?: number): Promise<ConnectionProblem[]> {
  const scopeGoogle = workspaceId === undefined ? undefined : eq(googleAccounts.workspaceId, workspaceId);
  const scopePosthog = workspaceId === undefined ? undefined : eq(posthogAccounts.workspaceId, workspaceId);
  const scopePlausible = workspaceId === undefined ? undefined : eq(plausibleAccounts.workspaceId, workspaceId);
  const scopeUmami = workspaceId === undefined ? undefined : eq(umamiAccounts.workspaceId, workspaceId);
  const [google, posthog, plausible, umami] = await Promise.all([
    db
      .select({ workspaceId: googleAccounts.workspaceId, workspace: workspaces.name, account: googleAccounts.email, status: googleAccounts.status, error: googleAccounts.lastError })
      .from(googleAccounts)
      .innerJoin(workspaces, eq(workspaces.id, googleAccounts.workspaceId))
      .where(and(scopeGoogle, or(ne(googleAccounts.status, "active"), isNotNull(googleAccounts.lastError)))),
    db
      .select({ workspaceId: posthogAccounts.workspaceId, workspace: workspaces.name, account: posthogAccounts.region, status: posthogAccounts.status, error: posthogAccounts.lastError })
      .from(posthogAccounts)
      .innerJoin(workspaces, eq(workspaces.id, posthogAccounts.workspaceId))
      .where(and(scopePosthog, or(ne(posthogAccounts.status, "active"), isNotNull(posthogAccounts.lastError)))),
    db
      .select({ workspaceId: plausibleAccounts.workspaceId, workspace: workspaces.name, status: plausibleAccounts.status, error: plausibleAccounts.lastError })
      .from(plausibleAccounts)
      .innerJoin(workspaces, eq(workspaces.id, plausibleAccounts.workspaceId))
      .where(and(scopePlausible, or(ne(plausibleAccounts.status, "active"), isNotNull(plausibleAccounts.lastError)))),
    db
      .select({ workspaceId: umamiAccounts.workspaceId, workspace: workspaces.name, baseUrl: umamiAccounts.baseUrl, status: umamiAccounts.status, error: umamiAccounts.lastError })
      .from(umamiAccounts)
      .innerJoin(workspaces, eq(workspaces.id, umamiAccounts.workspaceId))
      .where(and(scopeUmami, or(ne(umamiAccounts.status, "active"), isNotNull(umamiAccounts.lastError)))),
  ]);
  return [
    ...google.map((g) => ({ ...g, service: "Google" as const })),
    ...posthog.map((p) => ({ ...p, account: `${p.account.toUpperCase()} Cloud`, service: "PostHog" as const })),
    ...plausible.map((p) => ({ ...p, account: "Plausible Cloud", service: "Plausible" as const })),
    ...umami.map(({ baseUrl, ...u }) => ({ ...u, account: baseUrl ? `Self-hosted · ${baseUrl}` : "Umami Cloud", service: "Umami" as const })),
  ];
}

export interface PausedJob {
  workspaceId: number;
  workspace: string;
  domain: string;
  job: string;
  reason: string;
  message: string;
  pausedAt: string;
}

/** Scheduled jobs stopped by a limit, waiting for an upgrade or the next passing run. */
export async function pausedJobs(workspaceId?: number): Promise<PausedJob[]> {
  const rows = await db
    .select({
      workspaceId: workspaceJobPauses.workspaceId,
      workspace: workspaces.name,
      domain: projects.domain,
      job: workspaceJobPauses.job,
      reason: workspaceJobPauses.reason,
      message: workspaceJobPauses.message,
      pausedAt: workspaceJobPauses.pausedAt,
    })
    .from(workspaceJobPauses)
    .innerJoin(workspaces, eq(workspaces.id, workspaceJobPauses.workspaceId))
    .innerJoin(projects, eq(projects.id, workspaceJobPauses.projectId))
    .where(workspaceId === undefined ? undefined : eq(workspaceJobPauses.workspaceId, workspaceId));
  return rows.map((r) => ({ ...r, pausedAt: r.pausedAt.toISOString() }));
}

export interface NearCeiling {
  workspaceId: number;
  workspace: string;
  plan: string;
  spentUsd: number;
  ceilingUsd: number;
}

/** Workspaces whose spend this month is at least NEAR_CEILING_SHARE of their plan's ceiling. */
export async function nearCeiling(): Promise<NearCeiling[]> {
  const rows = await db
    .select({
      workspaceId: workspaces.id,
      workspace: workspaces.name,
      plan: workspaces.plan,
      limits: workspaces.limits,
      spentUsd: sql<number>`${workspaceUsage.spentUsd}::float`,
    })
    .from(workspaces)
    .innerJoin(workspaceUsage, and(eq(workspaceUsage.workspaceId, workspaces.id), eq(workspaceUsage.month, sql`date_trunc('month', now())::date`)))
    .where(gte(workspaceUsage.spentUsd, 0.01));
  return rows.flatMap((r) => {
    const ceilingUsd = limitsFor(r).ceilingUsd;
    if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0 || r.spentUsd < ceilingUsd * NEAR_CEILING_SHARE) return [];
    return [{ workspaceId: r.workspaceId, workspace: r.workspace, plan: r.plan, spentUsd: r.spentUsd, ceilingUsd }];
  });
}

/** A low balance at the last daily check, and a 402 from the last day that no check has answered since. */
export async function dataForSEOBalanceProblems(now = new Date()): Promise<BalanceProblem[]> {
  return balanceProblems(await readBalanceState(), now);
}

export interface Health {
  worker: WorkerProblem[];
  balance: BalanceProblem[];
  failed: FailedJob[];
  syncs: SyncRow[];
  connections: ConnectionProblem[];
  paused: PausedJob[];
  alerts: SpendAlert[];
  near: NearCeiling[];
  /** Workspaces that can't spend: suspended ones, and whatever the plan stops (`@/plan-policy/admin`). */
  stopped: AdminStopped;
}

export async function platformHealth(): Promise<Health> {
  const [worker, balance, failed, syncs, connections, paused, alerts, near, stopped] = await Promise.all([
    workerHealth(),
    dataForSEOBalanceProblems(),
    failedJobs(),
    syncProblems(),
    connectionProblems(),
    pausedJobs(),
    findSpendAlerts(),
    nearCeiling(),
    admin.stopped(),
  ]);
  return { worker, balance, failed, syncs, connections, paused, alerts, near, stopped };
}
