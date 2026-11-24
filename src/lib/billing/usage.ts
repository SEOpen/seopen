import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { SpendRefusedError, type Refusal } from "./errors";

/**
 * The atomic spend meter. Reading month-to-date spend and then
 * calling lets two calls at once both pass the ceiling, so every paid call instead:
 *
 * 1. reserves its estimate with one conditional UPDATE on the workspace's row for the month
 *    (`spent + reserved + est <= ceiling`, plus the research credits for a research call) and on the
 *    platform's row (`platform.monthly_cap_usd`), in one transaction: either both hold or neither;
 * 2. makes the call;
 * 3. settles: releases the estimate and adds the real cost (or releases it alone if the call failed).
 *
 * Rows are created on first use each month, seeded from the ledger, so a deploy mid-month keeps
 * the month's spend. A reservation leaked by a crash is cleared by the daily billing job.
 */

/** Modules whose on-demand calls count as research credits. */
export const RESEARCH_MODULES: ReadonlySet<string> = new Set(["domains", "keywords", "backlinks", "local"]);

export type Exec = Pick<typeof db, "execute">;

/** The meter's month. Anything reading the same month from the ledger starts here, so it can't disagree on the boundary. */
export const MONTH = sql`date_trunc('month', now())::date`;

export interface Reservation {
  /** Its `spend_reservations` row, deleted when it settles. */
  id: number;
  workspaceId: number;
  /** The month the reservation was made in (YYYY-MM-DD), so a call that crosses midnight settles the right row. */
  month: string;
  estimateUsd: number;
  research: boolean;
  /** What a research call holds against research credits when it's less than `estimateUsd`. */
  researchEstimateUsd?: number;
  /** The `spend_reservations` row holding the rest of the estimate when it's split that way. */
  restId?: number;
}

/** What a reservation holds against research credits. */
const researchHeld = (r: Pick<Reservation, "estimateUsd" | "research" | "researchEstimateUsd">) => (r.research ? (r.researchEstimateUsd ?? r.estimateUsd) : 0);

export interface UsageRow {
  spentUsd: number;
  reservedUsd: number;
  researchUsd: number;
  researchReservedUsd: number;
}

const num = (v: unknown) => Number(v ?? 0);

/**
 * Creates this month's row for the workspace (and the platform) if missing, seeded from the ledger.
 * This runs before every read and reservation, so `not exists` keeps the ledger sum to the one call
 * that makes the row: Postgres checks it first and skips the scan. `on conflict` covers two calls
 * making the row at once.
 */
async function ensureRows(x: Exec, workspaceId: number) {
  await x.execute(sql`
    insert into workspace_usage (workspace_id, month, spent_usd, research_usd)
    select ${workspaceId}, ${MONTH},
      coalesce(sum(charged_usd), 0),
      coalesce(sum(charged_usd) filter (where module in ('domains', 'keywords', 'backlinks', 'local')), 0)
    from api_ledger
    where workspace_id = ${workspaceId} and created_at >= ${MONTH}
      and not exists (select 1 from workspace_usage where workspace_id = ${workspaceId} and month = ${MONTH})
    on conflict do nothing`);
  await x.execute(sql`
    insert into platform_usage (month, spent_usd)
    select ${MONTH}, coalesce(sum(cost_usd), 0) from api_ledger
    where created_at >= ${MONTH} and not exists (select 1 from platform_usage where month = ${MONTH})
    on conflict do nothing`);
}

/** `null` means no limit. Postgres compares numerics exactly, so pass dollars as text. */
const usd = (n: number | null) => (n === null || !Number.isFinite(n) ? null : n.toFixed(6));

export interface ReserveArgs {
  workspaceId: number;
  estimateUsd: number;
  research: boolean;
  /**
   * For a research call, what to hold against research credits when that's less than the estimate:
   * the ceiling still holds the whole estimate. Defaults to the estimate.
   */
  researchEstimateUsd?: number;
  /** The workspace's hard ceiling this month; null for none. */
  ceilingUsd: number | null;
  /** Research credits in dollars; null for unlimited. */
  creditsUsd: number | null;
  /** platform.monthly_cap_usd; null when unset. */
  platformCapUsd: number | null;
  /** Messages for a refusal, by code. */
  refusals: { ceiling: Refusal; credits: Refusal; platform: Refusal };
}

/** Reserves `estimateUsd` for one paid call, or throws SpendRefusedError and reserves nothing. */
export async function reserve(a: ReserveArgs): Promise<Reservation> {
  const est = Math.max(0, a.estimateUsd);
  const researchEst = a.research ? Math.min(est, Math.max(0, a.researchEstimateUsd ?? est)) : 0;
  const split = researchEst < est && a.research;
  await ensureRows(db, a.workspaceId);
  return db.transaction(async (tx) => {
    const ceiling = usd(a.ceilingUsd);
    const credits = a.research ? usd(a.creditsUsd) : null;
    const estText = est.toFixed(6);
    const researchText = researchEst.toFixed(6);
    const fits = (used: SQL, limit: string | null, amount = estText): SQL =>
      limit === null ? sql`true` : sql`(${used} < ${limit}::numeric and ${used} + ${amount}::numeric <= ${limit}::numeric)`;

    const ws = await tx.execute<{ month: string }>(sql`
      update workspace_usage set
        reserved_usd = reserved_usd + ${estText}::numeric,
        research_reserved_usd = research_reserved_usd + ${researchText}::numeric,
        updated_at = now()
      where workspace_id = ${a.workspaceId} and month = ${MONTH}
        and ${fits(sql`(spent_usd + reserved_usd)`, ceiling)}
        and ${fits(sql`(research_usd + research_reserved_usd)`, credits, researchText)}
      returning month::text as month`);
    if (!ws.length) {
      const [row] = await tx.execute<Record<string, string>>(sql`
        select spent_usd, reserved_usd, research_usd, research_reserved_usd from workspace_usage
        where workspace_id = ${a.workspaceId} and month = ${MONTH}`);
      const spent = num(row?.spent_usd) + num(row?.reserved_usd);
      const creditsOut = credits !== null && num(row?.research_usd) + num(row?.research_reserved_usd) + researchEst > Number(credits);
      const ceilingOut = ceiling !== null && spent + est > Number(ceiling);
      const refusal = creditsOut && !(ceilingOut && spent >= Number(ceiling)) ? a.refusals.credits : a.refusals.ceiling;
      throw new SpendRefusedError(a.workspaceId, refusal, { spentUsd: spent, capUsd: a.ceilingUsd ?? 0, estimateUsd: est });
    }

    const platformCap = usd(a.platformCapUsd);
    const platform = await tx.execute(sql`
      update platform_usage set reserved_usd = reserved_usd + ${estText}::numeric, updated_at = now()
      where month = ${MONTH} and ${fits(sql`(spent_usd + reserved_usd)`, platformCap)}
      returning month`);
    // Throwing rolls back the workspace's reservation too.
    if (!platform.length) throw new SpendRefusedError(a.workspaceId, a.refusals.platform, { capUsd: a.platformCapUsd ?? 0, estimateUsd: est });

    // A split reservation is two rows, the research part and the rest, so the leaked-reservation
    // cleanup takes the right amount off each meter without a column for the second amount.
    const hold = (amount: string, research: boolean) =>
      tx.execute<{ id: number }>(sql`
        insert into spend_reservations (workspace_id, month, estimate_usd, research)
        values (${a.workspaceId}, ${ws[0].month}::date, ${amount}::numeric, ${research})
        returning id`);
    const [held] = await hold(split ? researchText : estText, a.research);
    const reservation: Reservation = { id: Number(held.id), workspaceId: a.workspaceId, month: ws[0].month, estimateUsd: est, research: a.research };
    if (!split) return reservation;
    const [rest] = await hold((est - researchEst).toFixed(6), false);
    return { ...reservation, researchEstimateUsd: researchEst, restId: Number(rest.id) };
  });
}

/**
 * Releases a reservation and records what the call really cost: `chargedUsd` against the
 * workspace (and its research credits for a research call), `costUsd` against the platform. A
 * reservation the cleanup already released as leaked releases nothing again, so it can't eat
 * another call's. The call has already happened, so nothing here refuses: a real cost above what was
 * held (against the ceiling or research credits) is recorded in full.
 */
export async function settle(r: Reservation, cost: { chargedUsd: number; costUsd: number }): Promise<void> {
  const charged = (Number.isFinite(cost.chargedUsd) ? cost.chargedUsd : 0).toFixed(6);
  const paid = (Number.isFinite(cost.costUsd) ? cost.costUsd : 0).toFixed(6);
  await db.transaction(async (tx) => {
    // A split reservation's two rows were made in one transaction, so the cleanup takes both or neither.
    const held = await tx.execute(sql`delete from spend_reservations where id in (${r.id}, ${r.restId ?? r.id}) returning id`);
    const est = held.length ? r.estimateUsd.toFixed(6) : "0";
    const researchEst = held.length ? researchHeld(r).toFixed(6) : "0";
    await tx.execute(sql`
      update workspace_usage set
        reserved_usd = greatest(reserved_usd - ${est}::numeric, 0),
        spent_usd = spent_usd + ${charged}::numeric,
        research_usd = research_usd + ${r.research ? charged : "0"}::numeric,
        research_reserved_usd = greatest(research_reserved_usd - ${researchEst}::numeric, 0),
        updated_at = now()
      where workspace_id = ${r.workspaceId} and month = ${r.month}::date`);
    await tx.execute(sql`
      update platform_usage set
        reserved_usd = greatest(reserved_usd - ${est}::numeric, 0),
        spent_usd = spent_usd + ${paid}::numeric,
        updated_at = now()
      where month = ${r.month}::date`);
  });
}

/** Releases a reservation whose call never ran or failed before anything was billed. */
export const release = (r: Reservation) => settle(r, { chargedUsd: 0, costUsd: 0 });

/**
 * Adds a cost outside a reservation: a ledger adjustment such as a crawl refund (negative) or the
 * real cost of an answer above its prepay. It has already happened, so it isn't refused.
 */
/** Adds a settled cost to the meters. Pass a transaction as `x` to write it with the caller's other changes. */
export async function addUsage(workspaceId: number, cost: { chargedUsd: number; costUsd: number; research?: boolean }, x: Exec = db): Promise<void> {
  await ensureRows(x, workspaceId);
  const charged = cost.chargedUsd.toFixed(6);
  await x.execute(sql`
    update workspace_usage set
      spent_usd = spent_usd + ${charged}::numeric,
      research_usd = greatest(research_usd + ${cost.research ? charged : "0"}::numeric, 0),
      updated_at = now()
    where workspace_id = ${workspaceId} and month = ${MONTH}`);
  await x.execute(sql`
    update platform_usage set spent_usd = spent_usd + ${cost.costUsd.toFixed(6)}::numeric, updated_at = now()
    where month = ${MONTH}`);
}

/** This month's meter for a workspace. */
export async function monthUsage(workspaceId: number): Promise<UsageRow> {
  await ensureRows(db, workspaceId);
  const [row] = await db.execute<Record<string, string>>(sql`
    select spent_usd, reserved_usd, research_usd, research_reserved_usd from workspace_usage
    where workspace_id = ${workspaceId} and month = ${MONTH}`);
  return {
    spentUsd: num(row?.spent_usd),
    reservedUsd: num(row?.reserved_usd),
    researchUsd: num(row?.research_usd),
    researchReservedUsd: num(row?.research_reserved_usd),
  };
}

/** What DataForSEO billed this month across every workspace, including reservations in flight. */
export async function platformMonthUsage(): Promise<{ spentUsd: number; reservedUsd: number }> {
  await db.execute(sql`
    insert into platform_usage (month, spent_usd)
    select ${MONTH}, coalesce(sum(cost_usd), 0) from api_ledger where created_at >= ${MONTH}
    on conflict do nothing`);
  const [row] = await db.execute<Record<string, string>>(sql`select spent_usd, reserved_usd from platform_usage where month = ${MONTH}`);
  return { spentUsd: num(row?.spent_usd), reservedUsd: num(row?.reserved_usd) };
}

/**
 * Clears reservations nobody settled (the process died mid-call). No call outlives a job's
 * 15-minute expiry, so a reservation over an hour old was leaked: its `spend_reservations` row goes
 * and its amount comes off the workspace's meter, however busy that row is. `updated_at` is left
 * alone. A workspace row untouched for an hour has nothing in flight either, so it's cleared whole,
 * which also catches reservations made before they were recorded one by one (migration 0030).
 *
 * The platform's row is touched by every workspace's calls, so on a busy platform it is never
 * quiet for an hour. Every reservation is made and settled on a workspace's row and then the
 * platform's, in one transaction, so the platform's reservations are the sum of the workspaces'
 * for that month: it's set to that sum, which keeps the live ones. Its row is locked first, so a
 * call that's mid-way either committed before the sum is read or moves the platform row after it.
 */
export async function releaseStaleReservations(): Promise<number> {
  const leaked = await db.execute<{ workspace_id: number }>(sql`
    with gone as (
      delete from spend_reservations where created_at < now() - interval '1 hour'
      returning workspace_id, month, estimate_usd, research
    ), sums as (
      select workspace_id, month, sum(estimate_usd) as est, coalesce(sum(estimate_usd) filter (where research), 0) as research_est
      from gone group by workspace_id, month
    )
    update workspace_usage w set
      reserved_usd = greatest(w.reserved_usd - s.est, 0),
      research_reserved_usd = greatest(w.research_reserved_usd - s.research_est, 0)
    from sums s
    where w.workspace_id = s.workspace_id and w.month = s.month
    returning w.workspace_id`);
  const ws = await db.execute<{ workspace_id: number }>(sql`
    update workspace_usage set reserved_usd = 0, research_reserved_usd = 0
    where updated_at < now() - interval '1 hour' and (reserved_usd <> 0 or research_reserved_usd <> 0)
    returning workspace_id`);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select month from platform_usage where reserved_usd <> 0 order by month for update`);
    await tx.execute(sql`
      update platform_usage p set reserved_usd = coalesce((select sum(w.reserved_usd) from workspace_usage w where w.month = p.month), 0)
      where p.reserved_usd <> 0`);
  });
  return new Set([...leaked, ...ws].map((r) => r.workspace_id)).size;
}

/**
 * Claims this month's limit-reached email for a workspace (src/lib/billing/limit-email.ts), or null
 * if it's taken. One conditional UPDATE on the month's row, so of any number of refusals at once
 * only one wins, and next month's new row can claim again. It leaves `updated_at` alone, which
 * releaseStaleReservations reads as "a call touched this row". `resetsAt` is when the month's meter
 * ends, from the same clock and time zone as MONTH.
 */
export async function claimLimitEmail(workspaceId: number): Promise<{ month: string; resetsAt: Date } | null> {
  await ensureRows(db, workspaceId);
  const [row] = await db.execute<{ month: string; resets_at: string }>(sql`
    update workspace_usage set limit_email_at = now()
    where workspace_id = ${workspaceId} and month = ${MONTH} and limit_email_at is null
    returning month::text as month, extract(epoch from date_trunc('month', now()) + interval '1 month')::text as resets_at`);
  return row ? { month: row.month, resetsAt: new Date(Number(row.resets_at) * 1000) } : null;
}

/** Gives a claim back when the email couldn't be sent, so a later refusal tries again. */
export async function releaseLimitEmail(workspaceId: number, month: string): Promise<void> {
  await db.execute(sql`update workspace_usage set limit_email_at = null where workspace_id = ${workspaceId} and month = ${month}::date`);
}
