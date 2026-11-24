import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiLedger, settings, workspaces } from "@/db/schema";
import { emailConfigured, sendEmail } from "@/lib/email";
import { formatUsd } from "@/lib/format";
import { emailOrigin } from "@/lib/recap/origin";
import { contactEmail } from "@/lib/instance";
import { platformCapUsd, spendState } from "./spend";
import { MONTH, platformMonthUsage } from "./usage";

/**
 * The owner's daily spend alert, against trial abuse: any workspace that
 * was charged more than $2 in the last day, or more than half its ceiling in the last week. The
 * internal plan is the owner's own and isn't reported. Logged always; emailed when Resend is set up.
 */

export const DAILY_ALERT_USD = 2;
export const WEEKLY_ALERT_SHARE = 0.5;
/**
 * Where the owner's alerts go (spend, platform cap, DataForSEO balance, worker watch), or why they aren't
 * emailed here: they need Resend and an address, OWNER_ALERT_EMAIL or else the contact address. Unsent
 * alerts still go to the log.
 */
export function ownerAlertTarget(): { to: string } | { off: string } {
  if (!emailConfigured()) return { off: "RESEND_API_KEY isn't set here" };
  const to = process.env.OWNER_ALERT_EMAIL?.trim() || contactEmail();
  return to ? { to } : { off: "OWNER_ALERT_EMAIL isn't set here" };
}

export interface SpendAlert {
  workspaceId: number;
  name: string;
  plan: string;
  dayUsd: number;
  weekUsd: number;
  ceilingUsd: number;
  reasons: string[];
}

/** Pure: which rows cross a threshold, and why. */
export function alertReasons(row: { dayUsd: number; weekUsd: number; ceilingUsd: number }): string[] {
  const out: string[] = [];
  if (row.dayUsd > DAILY_ALERT_USD) out.push(`${formatUsd(row.dayUsd)} in the last day (over ${formatUsd(DAILY_ALERT_USD, 0)})`);
  if (Number.isFinite(row.ceilingUsd) && row.ceilingUsd > 0 && row.weekUsd > row.ceilingUsd * WEEKLY_ALERT_SHARE) {
    out.push(`${formatUsd(row.weekUsd)} in the last 7 days, ${Math.round((row.weekUsd / row.ceilingUsd) * 100)}% of its ${formatUsd(row.ceilingUsd)} ceiling`);
  }
  return out;
}

export async function findSpendAlerts(): Promise<SpendAlert[]> {
  const rows = await db
    .select({
      workspaceId: workspaces.id,
      name: workspaces.name,
      plan: workspaces.plan,
      dayUsd: sql<number>`coalesce(sum(${apiLedger.chargedUsd}) filter (where ${apiLedger.createdAt} >= now() - interval '1 day'), 0)::float`,
      weekUsd: sql<number>`coalesce(sum(${apiLedger.chargedUsd}), 0)::float`,
    })
    .from(apiLedger)
    .innerJoin(workspaces, eq(workspaces.id, apiLedger.workspaceId))
    .where(and(gte(apiLedger.createdAt, sql`now() - interval '7 days'`), ne(workspaces.plan, "internal")))
    .groupBy(workspaces.id, workspaces.name, workspaces.plan);
  const out: SpendAlert[] = [];
  for (const r of rows) {
    const ceilingUsd = (await spendState(r.workspaceId)).ceilingUsd;
    const reasons = alertReasons({ ...r, ceilingUsd });
    if (reasons.length) out.push({ ...r, ceilingUsd, reasons });
  }
  return out;
}

export async function sendSpendAlerts(): Promise<{ alerts: number; emailed: boolean }> {
  const alerts = await findSpendAlerts();
  if (!alerts.length) return { alerts: 0, emailed: false };
  const lines = alerts.map((a) => `Workspace ${a.workspaceId} "${a.name}" (${a.plan}): ${a.reasons.join("; ")}`);
  for (const l of lines) console.warn(`[billing.alerts] ${l}`);
  const target = ownerAlertTarget();
  if ("off" in target) return { alerts: alerts.length, emailed: false };
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  await sendEmail({
    to: target.to,
    subject: `SEOpen spend alert: ${alerts.length} workspace${alerts.length === 1 ? "" : "s"}`,
    text: `${lines.join("\n")}\n\nReview and suspend on /admin.`,
    html: `<p>These workspaces crossed a spend alert:</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p>Review them, and suspend if needed, on /admin.</p>`,
  });
  return { alerts: alerts.length, emailed: true };
}

/**
 * The owner's platform cap alert: at 80% and at 100% of
 * `platform.monthly_cap_usd`, once each per cap per month. At 100% every workspace's paid calls are
 * refused (PLATFORM_REFUSAL), so that one matters most. The daily job checks, and so does the first
 * platform refusal (queueLimitEmail), so the 100% alert arrives when work stops, not at 08:00.
 */

export type PlatformAlertPercent = 80 | 100;

/** Pure: the highest alert share this month's spend has reached, or null below 80% or with no cap. */
export function platformAlertPercent(usedUsd: number, capUsd: number | null): PlatformAlertPercent | null {
  if (capUsd === null || !(capUsd > 0) || !Number.isFinite(usedUsd)) return null;
  if (usedUsd >= capUsd) return 100;
  if (usedUsd >= capUsd * 0.8) return 80;
  return null;
}

/** "November 2026", from the meter's month (YYYY-MM-DD). */
export function monthName(month: string): string {
  return new Date(`${month.slice(0, 10)}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** An Admin page's address for an alert email (emailOrigin says where links point). */
export function adminUrl(path: `/admin${string}`): string {
  return `${emailOrigin()}${path}`;
}

const STOPS =
  "every workspace's paid calls are refused until the 1st or until you raise the cap: rank checks, site audits, Lighthouse, AI visibility runs, Local SEO checks, backlinks snapshots, research lookups and the site's free tools. Scheduled jobs pause. Raising the cap starts them again at once, and the 08:00 billing job does on the 1st. Cached results still load.";

/** Pure: the email for one alert. */
export function platformAlertMessage(a: { percent: PlatformAlertPercent; spentUsd: number; reservedUsd: number; capUsd: number; month: string; url: string }) {
  const month = monthName(a.month);
  const share = Math.floor(((a.spentUsd + a.reservedUsd) / a.capUsd) * 100 + 1e-9);
  const inFlight = a.reservedUsd >= 0.005 ? `, plus ${formatUsd(a.reservedUsd, 2)} held by calls in progress` : "";
  const figures = `DataForSEO spend across every workspace for ${month} is ${formatUsd(a.spentUsd, 2)}${inFlight}: ${share}% of the ${formatUsd(a.capUsd, 2)} platform cap.`;
  const subject = a.percent === 100 ? `SEOpen platform cap reached: paid calls stopped for ${month}` : `SEOpen platform cap: ${share}% used for ${month}`;
  const paragraphs =
    a.percent === 100
      ? [figures, `Now ${STOPS}`, `Raise the cap on Admin → Spend: ${a.url}`]
      : [figures, `At 100%, ${STOPS}`, `If this month needs more, raise the cap on Admin → Spend before then: ${a.url}`];
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return { subject, text: paragraphs.join("\n\n"), html: paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") };
}

/** One settings row per alert sent, named by the month, the share and the cap it went out for. */
export const platformAlertKey = (month: string, percent: PlatformAlertPercent, capUsd: number) => `platform.cap_alert:${month}:${percent}:${capUsd}`;

/** Claims one alert with an insert only one caller can win, so any number of checks at once send it once. */
export async function claimAlert(key: string): Promise<boolean> {
  const rows = await db.insert(settings).values({ key, value: { claimedAt: new Date().toISOString() } }).onConflictDoNothing().returning({ key: settings.key });
  return rows.length > 0;
}

export interface PlatformReads {
  cap: () => Promise<number | null>;
  usage: () => Promise<{ spentUsd: number; reservedUsd: number }>;
}

/**
 * Emails the owner when this month's platform spend has reached 80% or 100% of the cap and that
 * alert hasn't gone out for this month and this cap, so a new month or a raised cap can send again.
 * Spend counts reservations in flight, as the cap does. Without RESEND_API_KEY it logs and claims
 * nothing; a failed send gives the claim back and throws.
 */
export async function sendPlatformCapAlert(
  read: PlatformReads = { cap: platformCapUsd, usage: platformMonthUsage },
): Promise<{ percent: PlatformAlertPercent | null; emailed: boolean }> {
  const capUsd = await read.cap();
  if (capUsd === null) return { percent: null, emailed: false };
  const [{ month }] = await db.execute<{ month: string }>(sql`select ${MONTH}::text as month`);
  const usage = await read.usage();
  const percent = platformAlertPercent(usage.spentUsd + usage.reservedUsd, capUsd);
  if (percent === null) return { percent, emailed: false };

  const line = `[billing.alerts] platform spend ${formatUsd(usage.spentUsd + usage.reservedUsd, 2)} of the ${formatUsd(capUsd, 2)} cap for ${month} (${percent}% alert)`;
  const target = ownerAlertTarget();
  if ("off" in target) {
    console.warn(`${line}: not emailed, ${target.off}`);
    return { percent, emailed: false };
  }
  const key = platformAlertKey(month, percent, capUsd);
  if (!(await claimAlert(key))) return { percent, emailed: false };
  console.warn(line);
  try {
    await sendEmail({ to: target.to, ...platformAlertMessage({ percent, ...usage, capUsd, month, url: adminUrl("/admin/spend") }) });
  } catch (err) {
    await db.delete(settings).where(eq(settings.key, key));
    throw err;
  }
  // Reaching 100% first says everything the 80% alert would.
  if (percent === 100) await claimAlert(platformAlertKey(month, 80, capUsd));
  return { percent, emailed: true };
}
