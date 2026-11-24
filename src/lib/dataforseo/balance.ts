import { eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiLedger, settings } from "@/db/schema";
import { adminUrl, claimAlert, ownerAlertTarget } from "@/lib/billing/alerts";
import { platformCapUsd } from "@/lib/billing/spend";
import { sendEmail } from "@/lib/email";
import { formatUsd } from "@/lib/format";

/**
 * The owner's DataForSEO balance alert. SEOpen's caps
 * stop its own spend, but nothing else watched the prepaid balance they spend from: when it ran out
 * on 2026-11-09, every paid call answered HTTP 402 and jobs failed until someone looked.
 *
 * - The daily `billing.alerts` job reads the balance from `appendix/user_data`, which is free, and
 *   emails OWNER_ALERT_EMAIL when it's under the threshold. The threshold is a week of calls at the
 *   higher of the platform cap's pace and the last week's spend, at least BALANCE_FLOOR_USD, unless
 *   DATAFORSEO_BALANCE_ALERT_USD sets a figure.
 * - The client calls `notePaymentRequired` on a 402 (or DataForSEO's 40200 or 40210), which emails at
 *   once. The web app and the worker both reach it, so the claim lives in Postgres.
 * - The client calls `noteDailyLimit` on DataForSEO's 40203 ("cost limit exceeded"): the daily spend
 *   limit set in DataForSEO's dashboard (Settings) is reached, so paid calls fail until 00:00 UTC.
 *   The balance can be fine then, so it's an alert of its own.
 * - Each goes at most once a UTC day. The claim is a `settings` row named
 *   `platform.dfs_balance_alert:<day>:<low|payment>`, inserted with `on conflict do nothing`, as the
 *   platform cap alert does. A 402 alert also claims the day's low alert, which it says more than.
 *   Without RESEND_API_KEY it logs and claims nothing; a failed send gives the claim back.
 * - What the last check read, the last 402 and the last 40203 are kept in three more `settings` rows,
 *   which Admin → Health reads (`balanceProblems`).
 */

/** Days of calls the balance should cover: time to notice the email and top up. */
export const BALANCE_RUNWAY_DAYS = 7;
/** The threshold never goes under this, even with no cap and nothing spent. */
export const BALANCE_FLOOR_USD = 10;
/** Set to a dollar figure to use it as the threshold instead of the computed one. */
export const BALANCE_ALERT_ENV = "DATAFORSEO_BALANCE_ALERT_USD";
/** How long Health shows a 402 that no balance check has answered since. */
export const PAYMENT_PROBLEM_HOURS = 24;

export const BALANCE_CHECK_KEY = "platform.dfs_balance_check";
export const PAYMENT_REQUIRED_KEY = "platform.dfs_payment_required";
export const DAILY_LIMIT_KEY = "platform.dfs_daily_limit";
export type BalanceAlertKind = "low" | "payment" | "limit";
export const balanceAlertKey = (day: string, kind: BalanceAlertKind) => `platform.dfs_balance_alert:${day}:${kind}`;

const TOP_UP_URL = "https://app.dataforseo.com";

const STOPS =
  "rank checks, site audits, Lighthouse, AI visibility runs, Local SEO checks, backlinks snapshots, research lookups and the site's free tools, in every workspace. Scheduled jobs fail rather than pause, so they pile up as failed jobs on Admin → Health. Cached results still load.";

export interface BalanceCheck {
  checkedAt: string;
  balanceUsd: number;
  thresholdUsd: number;
  low: boolean;
}

export interface PaymentRequired {
  at: string;
  endpoint: string;
}

/** HTTP 402, or DataForSEO's own "payment required" (40200) and "insufficient funds" (40210). */
export function isPaymentRequired(code: number): boolean {
  return code === 402 || code === 40200 || code === 40210;
}

/** DataForSEO's 40203: the account's daily spend limit (its dashboard, Settings) is reached. */
export function isDailyLimit(code: number | undefined): boolean {
  return code === 40203;
}

/** Pure: the dollars a day the balance has to cover, the higher of the platform cap over 30 days and the last 7 days' spend. */
export function dailyPaceUsd({ capUsd, weekCostUsd }: { capUsd: number | null; weekCostUsd: number }): number {
  return Math.max(capUsd && capUsd > 0 ? capUsd / 30 : 0, weekCostUsd > 0 ? weekCostUsd / 7 : 0);
}

/** Pure: the figure a balance under which is low. */
export function balanceThresholdUsd(a: { capUsd: number | null; weekCostUsd: number; configuredUsd: number | null }): number {
  if (a.configuredUsd !== null) return a.configuredUsd;
  return Math.max(BALANCE_FLOOR_USD, Math.round(BALANCE_RUNWAY_DAYS * dailyPaceUsd(a) * 100) / 100);
}

/** Pure: DATAFORSEO_BALANCE_ALERT_USD as a figure, or null when it's unset or not a usable number. */
export function configuredThresholdUsd(raw: string | undefined = process.env[BALANCE_ALERT_ENV]): number | null {
  if (!raw?.trim()) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "2026-11-09 14:03 UTC": the worker and the web app run in different zones, so emails say UTC. */
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type BalanceAlert =
  | { kind: "low"; balanceUsd: number; thresholdUsd: number; paceUsd: number; at: Date; url: string }
  | { kind: "payment"; endpoint: string; at: Date; last: { balanceUsd: number; checkedAt: string } | null; url: string }
  | { kind: "limit"; endpoint: string; at: Date; url: string };

/** Pure: the email for one alert. */
export function balanceAlertMessage(a: BalanceAlert) {
  const topUp = `Top up at ${TOP_UP_URL} (the smallest top-up is $50). The 08:00 billing job reads the balance again each day, and Admin → Health shows the problem until it finds enough: ${a.url}`;
  let subject: string;
  let paragraphs: string[];
  if (a.kind === "limit") {
    subject = "SEOpen: DataForSEO's daily spend limit is reached, paid calls are failing until 00:00 UTC";
    paragraphs = [
      `DataForSEO answered 40203 (cost limit exceeded) on ${a.endpoint} at ${utc(a.at)}, so the daily spend limit set in its dashboard is reached. The balance itself may be fine.`,
      `Until the limit resets at 00:00 UTC, every paid DataForSEO call fails: ${STOPS}`,
      `If this was real demand, raise the limit at ${TOP_UP_URL} under Settings. If not, Admin → Spend shows what spent it. Admin → Health shows the problem for the rest of the UTC day: ${a.url}`,
      "This alert goes at most once a day.",
    ];
  } else if (a.kind === "payment") {
    const last = a.last ? ` The last balance check, at ${utc(new Date(a.last.checkedAt))}, read ${formatUsd(a.last.balanceUsd, 2)}.` : "";
    subject = "SEOpen: DataForSEO refused a paid call for payment, paid calls are failing";
    paragraphs = [
      `DataForSEO answered HTTP 402 (payment required) on ${a.endpoint} at ${utc(a.at)}, so the account's balance has run out.${last}`,
      `Until it's topped up, every paid DataForSEO call fails: ${STOPS}`,
      topUp,
      "This alert goes at most once a day.",
    ];
  } else if (a.balanceUsd <= 0) {
    subject = `SEOpen: DataForSEO balance is used up (${formatUsd(a.balanceUsd, 2)}), paid calls are failing`;
    paragraphs = [
      `DataForSEO's balance is ${formatUsd(a.balanceUsd, 2)}, so every paid call fails with HTTP 402: ${STOPS}`,
      topUp,
      "This alert goes at most once a day, and again tomorrow if the balance is still low.",
    ];
  } else {
    const days = a.paceUsd > 0 ? Math.floor(a.balanceUsd / a.paceUsd) : null;
    const runway =
      days === null
        ? ""
        : ` At ${formatUsd(a.paceUsd, 2)} a day (the higher of the platform cap spread over 30 days and the last 7 days' spend) that's about ${days === 1 ? "1 day" : `${days} days`} of calls.`;
    subject = `SEOpen: DataForSEO balance is low, ${formatUsd(a.balanceUsd, 2)} left`;
    paragraphs = [
      `DataForSEO's balance is ${formatUsd(a.balanceUsd, 2)}, below the ${formatUsd(a.thresholdUsd, 2)} alert threshold.${runway}`,
      `When it runs out, every paid call fails with HTTP 402: ${STOPS}`,
      topUp,
      "This alert goes at most once a day, and again tomorrow if the balance is still low.",
    ];
  }
  return { subject, text: paragraphs.join("\n\n"), html: paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") };
}

/**
 * Pure: Health's rows. A low last check, a 402 from the last day that no check has answered since,
 * and a 40203 from the current UTC day, since the limit resets at 00:00 UTC.
 */
export function balanceProblems(state: { check: BalanceCheck | null; payment: PaymentRequired | null; limit?: PaymentRequired | null }, now = new Date()) {
  const out: { problem: string; detail: string; at: string }[] = [];
  const { check, payment } = state;
  if (check?.low) {
    out.push({
      problem: check.balanceUsd <= 0 ? "Used up" : "Low",
      detail: `${formatUsd(check.balanceUsd, 2)} left at the last check, under the ${formatUsd(check.thresholdUsd, 2)} alert threshold`,
      at: check.checkedAt,
    });
  }
  const at = payment ? new Date(payment.at).getTime() : NaN;
  if (payment && now.getTime() - at < PAYMENT_PROBLEM_HOURS * 3_600_000 && (!check || at > new Date(check.checkedAt).getTime())) {
    out.push({ problem: "Payment required", detail: `DataForSEO answered HTTP 402 on ${payment.endpoint}, so paid calls are failing`, at: payment.at });
  }
  const limit = state.limit;
  if (limit && limit.at.slice(0, 10) === now.toISOString().slice(0, 10)) {
    out.push({ problem: "Daily limit reached", detail: `DataForSEO answered 40203 on ${limit.endpoint}: its daily spend limit is reached, so paid calls fail until 00:00 UTC`, at: limit.at });
  }
  return out;
}

export type BalanceProblem = ReturnType<typeof balanceProblems>[number];

/** What the last check read, the last 402 and the last 40203, from `settings`. */
export async function readBalanceState(): Promise<{ check: BalanceCheck | null; payment: PaymentRequired | null; limit: PaymentRequired | null }> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [BALANCE_CHECK_KEY, PAYMENT_REQUIRED_KEY, DAILY_LIMIT_KEY]));
  const value = (key: string) => (rows.find((r) => r.key === key)?.value ?? null) as Record<string, unknown> | null;
  return {
    check: value(BALANCE_CHECK_KEY) as BalanceCheck | null,
    payment: value(PAYMENT_REQUIRED_KEY) as PaymentRequired | null,
    limit: value(DAILY_LIMIT_KEY) as PaymentRequired | null,
  };
}

async function saveState(key: string, value: BalanceCheck | PaymentRequired) {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

/**
 * Claims the day's alert and sends it, or returns false when it went out already, Resend isn't set
 * up here, or (for a low alert) the day's 402 alert has said it. A failed send gives the claim back and throws.
 */
async function sendBalanceAlert(kind: BalanceAlertKind, at: Date, alert: BalanceAlert, line: string): Promise<boolean> {
  const target = ownerAlertTarget();
  if ("off" in target) {
    console.warn(`${line}: not emailed, ${target.off}`);
    return false;
  }
  const day = at.toISOString().slice(0, 10);
  if (kind === "low") {
    const [covered] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, balanceAlertKey(day, "payment")));
    if (covered) return false;
  }
  const key = balanceAlertKey(day, kind);
  if (!(await claimAlert(key))) return false;
  console.warn(line);
  try {
    await sendEmail({ to: target.to, ...balanceAlertMessage(alert) });
  } catch (err) {
    await db.delete(settings).where(eq(settings.key, key));
    throw err;
  }
  if (kind === "payment") await claimAlert(balanceAlertKey(day, "low"));
  return true;
}

/** The live balance, from the free user_data endpoint. Loaded late, because the client imports this file. */
async function readDfsBalance(): Promise<number> {
  const { dfsGet, firstResult } = await import("./client");
  const res = await dfsGet<{ money?: { balance?: number } }>("appendix/user_data", { module: "core", free: true });
  const balance = Number(firstResult(res)?.money?.balance);
  if (!Number.isFinite(balance)) throw new Error("DataForSEO's user_data had no balance");
  return balance;
}

/** DataForSEO's bill across every workspace in the last 7 days. */
async function lastWeekCostUsd(): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${apiLedger.costUsd}), 0)` })
    .from(apiLedger)
    .where(gte(apiLedger.createdAt, sql`now() - interval '7 days'`));
  return Number(row?.total ?? 0);
}

export interface BalanceReads {
  readBalance: () => Promise<number>;
  cap: () => Promise<number | null>;
  weekCostUsd: () => Promise<number>;
  now: () => Date;
  configured: string | undefined;
}

/** The daily check: reads the balance, records it for Health, and emails the owner when it's low. */
export async function checkDataForSEOBalance(reads: Partial<BalanceReads> = {}): Promise<BalanceCheck & { emailed: boolean }> {
  const r: BalanceReads = { readBalance: readDfsBalance, cap: platformCapUsd, weekCostUsd: lastWeekCostUsd, now: () => new Date(), configured: process.env[BALANCE_ALERT_ENV], ...reads };
  const [balanceUsd, capUsd, weekCostUsd] = await Promise.all([r.readBalance(), r.cap(), r.weekCostUsd()]);
  const at = r.now();
  const thresholdUsd = balanceThresholdUsd({ capUsd, weekCostUsd, configuredUsd: configuredThresholdUsd(r.configured) });
  const check: BalanceCheck = { checkedAt: at.toISOString(), balanceUsd, thresholdUsd, low: balanceUsd < thresholdUsd };
  await saveState(BALANCE_CHECK_KEY, check);
  if (!check.low) return { ...check, emailed: false };
  const line = `[billing.alerts] DataForSEO balance ${formatUsd(balanceUsd, 2)}, under the ${formatUsd(thresholdUsd, 2)} alert threshold`;
  const alert: BalanceAlert = { kind: "low", balanceUsd, thresholdUsd, paceUsd: dailyPaceUsd({ capUsd, weekCostUsd }), at, url: adminUrl("/admin/health") };
  return { ...check, emailed: await sendBalanceAlert("low", at, alert, line) };
}

/** When this process last recorded a 402, so a burst of failing calls touches the database once a minute. */
let lastNoted: number | null = null;

/**
 * The client calls this on a refused payment, in the web app and the worker alike. It records the
 * 402 for Health and emails the owner the first time in a UTC day. It never throws: the call has
 * already failed, and this can't make it fail differently.
 */
export async function notePaymentRequired(endpoint: string, now = new Date()): Promise<void> {
  const t = now.getTime();
  if (lastNoted !== null && t >= lastNoted && t - lastNoted < 60_000) return;
  lastNoted = t;
  try {
    await saveState(PAYMENT_REQUIRED_KEY, { at: now.toISOString(), endpoint });
    const { check } = await readBalanceState();
    const last = check ? { balanceUsd: check.balanceUsd, checkedAt: check.checkedAt } : null;
    const line = `[dataforseo] HTTP 402 (payment required) on ${endpoint}: the DataForSEO balance has run out`;
    await sendBalanceAlert("payment", now, { kind: "payment", endpoint, at: now, last, url: adminUrl("/admin/health") }, line);
  } catch (err) {
    console.error("[dataforseo] couldn't send the DataForSEO balance alert", err instanceof Error ? err.message : err);
  }
}

/** When this process last recorded a 40203, for the same once-a-minute touch as a 402. */
let lastLimitNoted: number | null = null;

/**
 * The client calls this when DataForSEO answers 40203, in the web app and the worker alike. It
 * records it for Health and emails the owner the first time in a UTC day. It never throws.
 */
export async function noteDailyLimit(endpoint: string, now = new Date()): Promise<void> {
  const t = now.getTime();
  if (lastLimitNoted !== null && t >= lastLimitNoted && t - lastLimitNoted < 60_000) return;
  lastLimitNoted = t;
  try {
    await saveState(DAILY_LIMIT_KEY, { at: now.toISOString(), endpoint });
    const line = `[dataforseo] 40203 (cost limit exceeded) on ${endpoint}: DataForSEO's daily spend limit is reached`;
    await sendBalanceAlert("limit", now, { kind: "limit", endpoint, at: now, url: adminUrl("/admin/health") }, line);
  } catch (err) {
    console.error("[dataforseo] couldn't send the DataForSEO daily limit alert", err instanceof Error ? err.message : err);
  }
}
