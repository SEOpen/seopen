import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Days shown in the overview's daily charts, today included. */
export const OVERVIEW_DAYS = 30;

export type DayRow = { date: string; accounts: number; spendUsd: number };

/**
 * New accounts and DataForSEO cost per UTC day, with empty days as zeros. A plan's own daily counts
 * come from the plan policy (`@/plan-policy/admin`).
 */
export async function dailyActivity(days = OVERVIEW_DAYS): Promise<DayRow[]> {
  const rows = await db.execute<{ date: string; accounts: number; spend: number }>(sql`
    with d as (
      select generate_series((now() at time zone 'utc')::date - ${days - 1}::int, (now() at time zone 'utc')::date, interval '1 day')::date as day
    )
    select
      d.day::text as date,
      (select count(*)::int from users u where (u.created_at at time zone 'utc')::date = d.day) as accounts,
      (select coalesce(sum(l.cost_usd), 0)::float from api_ledger l where (l.created_at at time zone 'utc')::date = d.day) as spend
    from d
    order by d.day`);
  return [...rows].map((r) => ({ date: r.date, accounts: r.accounts, spendUsd: r.spend }));
}

/** Every account, the owner's included. */
export async function accountCount(): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from users`);
  return row.n;
}
