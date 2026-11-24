import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { alerts, alertSends, projects, users, workspaceMembers, workspaces } from "@/db/schema";
import { withEndedGrant } from "@/lib/billing/gates";
import { alertsMessage, emailConfigured, sendEmail } from "@/lib/email";
import { formatDateTimeZoned } from "@/lib/format";
import { recapOpen } from "@/lib/recap/gate";
import { emailOrigin } from "@/lib/recap/origin";
import { unsubscribeUrl } from "@/lib/recap/unsubscribe";
import { SCHEDULE_TIME_ZONE, type WallClock } from "@/lib/schedule";
import { workspaceTimeZone, type ProjectScope } from "@/lib/workspace";
import { todayIn } from "@/modules/google/windowing";
import { enabledRules } from "./record";
import { isAlertRule, RULES } from "./rules";

/**
 * Alert emails. They go to the people who get the weekly recap (the recap's plan and rollout gate,
 * verified address, recap on), less anyone who turned alert emails off. Per project and day on the
 * schedule's calendar there is at most one urgent email, sent as soon as an urgent rule fires, and
 * one daily email, sent from ALERTS_DAILY_AT with whatever hasn't gone yet. Each email carries
 * every alert not emailed yet, so same-day alerts go together and none goes twice.
 *
 * A send is claimed in alert_sends and its alerts attached before anything goes out. Resend gets a
 * key per send and person, and the claim's alerts never change, so a retry sends the same email and
 * the people who already have it don't get it again.
 */

export type SendKind = "urgent" | "daily";

/** When the day's email goes, on the schedule's clock: after the 06:00 rank checks have had time to finish. */
export const ALERTS_DAILY_AT: WallClock = "12:00";

/** Alerts older than this that never went out (nobody to send to then) stay in the history but aren't emailed. */
const EMAIL_WITHIN_MS = 7 * 86_400_000;
/** A failed send is retried for this long: Resend keeps an idempotency key 24 hours. */
const RETRY_WITHIN_MS = 20 * 3_600_000;

/** The schedule's calendar day: the day the once-a-day limit counts. */
export const alertDay = (now: Date) => todayIn(SCHEDULE_TIME_ZONE, now);

/** Whether the day's email may go yet, on the schedule's clock. */
export function pastDailyTime(now: Date): boolean {
  const clock = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: SCHEDULE_TIME_ZONE }).format(now);
  return clock >= ALERTS_DAILY_AT;
}

/** Who gets a workspace's alert emails. Empty when its plan doesn't have the recap. */
export async function alertRecipients(workspaceId: number) {
  const rows = await db
    .select({ userId: users.id, email: users.email, plan: workspaces.plan, grantedAt: workspaces.grantedAt, grantEndsAt: workspaces.grantEndsAt })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaces.id, workspaceId), eq(users.weeklyRecap, true), eq(users.alertEmails, true), eq(users.emailVerified, true), eq(workspaces.status, "active")))
    .orderBy(asc(users.id));
  return rows.filter((r) => recapOpen(withEndedGrant(r))).map((r) => ({ userId: r.userId, email: r.email }));
}

/** Open alerts of rules still on that no email has carried, from the past week. */
async function pendingAlerts(scope: ProjectScope, now: Date) {
  const on = await enabledRules(scope);
  const rows = await db
    .select({ id: alerts.id, rule: alerts.rule })
    .from(alerts)
    .where(
      and(
        eq(alerts.workspaceId, scope.workspaceId),
        eq(alerts.projectId, scope.projectId),
        isNull(alerts.resolvedAt),
        isNull(alerts.sendId),
        gte(alerts.detectedAt, new Date(now.getTime() - EMAIL_WITHIN_MS)),
      ),
    );
  return rows.filter((r) => isAlertRule(r.rule) && on.has(r.rule));
}

export type DeliverResult = "sent" | "nothing" | "limit" | "no-recipients" | "off" | "failed";

/**
 * Sends the project's alert email of this kind if one is due: urgent when an urgent alert is
 * waiting, daily when anything is. Refused once today's email of that kind went. Never throws: a
 * failed send is left for `retryUnsent`.
 */
export async function deliverAlerts(scope: ProjectScope, kind: SendKind, now = new Date()): Promise<DeliverResult> {
  // Without a key sendEmail only logs, which would use up the day's claim.
  if (!emailConfigured()) return "off";
  const pending = await pendingAlerts(scope, now);
  if (!pending.length || (kind === "urgent" && !pending.some((a) => isAlertRule(a.rule) && RULES[a.rule].urgent))) return "nothing";
  if (!(await alertRecipients(scope.workspaceId)).length) return "no-recipients";
  const sendId = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(alertSends)
      .values({ ...scope, day: alertDay(now), kind, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: alertSends.id });
    if (!claimed) return null;
    await tx
      .update(alerts)
      .set({ sendId: claimed.id })
      .where(and(inArray(alerts.id, pending.map((a) => a.id)), isNull(alerts.sendId)));
    return claimed.id;
  });
  if (sendId == null) return "limit";
  try {
    await sendClaimed(sendId);
    return "sent";
  } catch (err) {
    console.error(`[alerts] ${kind} email for project ${scope.projectId} not sent:`, err instanceof Error ? err.message : err);
    return "failed";
  }
}

/** Sends a claimed email to everyone who should get it, and marks it sent when all of them did. Throws if any send failed. */
export async function sendClaimed(sendId: number, now = new Date()): Promise<void> {
  const [send] = await db
    .select({ id: alertSends.id, workspaceId: alertSends.workspaceId, projectId: alertSends.projectId, name: projects.name, domain: projects.domain })
    .from(alertSends)
    .innerJoin(projects, and(eq(projects.id, alertSends.projectId), eq(projects.workspaceId, alertSends.workspaceId)))
    .where(eq(alertSends.id, sendId));
  if (!send) return;
  const items = await db.select().from(alerts).where(and(eq(alerts.workspaceId, send.workspaceId), eq(alerts.sendId, sendId))).orderBy(asc(alerts.detectedAt), asc(alerts.id));
  const [people, timeZone] = await Promise.all([alertRecipients(send.workspaceId), workspaceTimeZone({ workspaceId: send.workspaceId })]);
  const origin = emailOrigin();
  const base = `${origin}/projects/${send.projectId}/alerts`;
  const urgent = (rule: string) => isAlertRule(rule) && RULES[rule].urgent;
  const list = [...items].sort((a, b) => Number(urgent(b.rule)) - Number(urgent(a.rule)));
  let failed = 0;
  for (const person of people) {
    const message = alertsMessage({
      project: { name: send.name, domain: send.domain },
      alerts: list.map((a) => ({ title: a.title, detail: a.detail, source: a.source, found: formatDateTimeZoned(a.detectedAt, timeZone), urgent: urgent(a.rule), href: `${base}/${a.id}` })),
      alertsUrl: base,
      settingsUrl: `${origin}/settings`,
      unsubscribeUrl: unsubscribeUrl(origin, person.userId, "alerts"),
    });
    try {
      await sendEmail({ to: person.email, ...message }, { idempotencyKey: `alerts/${sendId}/${person.userId}` });
    } catch (err) {
      failed++;
      console.error(`[alerts] alert email ${sendId} not sent to one recipient:`, err instanceof Error ? err.message : err);
    }
  }
  if (failed) throw new Error(`${failed} of ${people.length} alert email${people.length === 1 ? "" : "s"} not sent`);
  await db.update(alertSends).set({ sentAt: now }).where(eq(alertSends.id, sendId));
}

/** Claimed emails that didn't all go out, from the retry window. */
async function unsentClaims(now: Date) {
  return db
    .select({ id: alertSends.id })
    .from(alertSends)
    .where(and(isNull(alertSends.sentAt), gte(alertSends.createdAt, new Date(now.getTime() - RETRY_WITHIN_MS))));
}

/** Projects with an alert waiting for its email. */
async function projectsWithPending(now: Date): Promise<ProjectScope[]> {
  return db
    .selectDistinct({ workspaceId: alerts.workspaceId, projectId: alerts.projectId })
    .from(alerts)
    .innerJoin(projects, and(eq(projects.id, alerts.projectId), eq(projects.workspaceId, alerts.workspaceId)))
    .innerJoin(workspaces, eq(workspaces.id, alerts.workspaceId))
    .where(
      and(
        isNull(alerts.resolvedAt),
        isNull(alerts.sendId),
        gte(alerts.detectedAt, new Date(now.getTime() - EMAIL_WITHIN_MS)),
        eq(projects.archived, false),
        eq(workspaces.status, "active"),
      ),
    );
}

export interface DeliverRun {
  retried: number;
  sent: number;
  failed: number;
}

/**
 * The hourly pass (alerts.deliver): retries emails that didn't all go out, sends an urgent email a
 * crawl couldn't, and from ALERTS_DAILY_AT sends each project's daily email. Throws after the rest
 * when a send failed, so the job's retry tries again.
 */
export async function deliverDue(now = new Date()): Promise<DeliverRun> {
  const run: DeliverRun = { retried: 0, sent: 0, failed: 0 };
  if (!emailConfigured()) return run;
  for (const { id } of await unsentClaims(now)) {
    try {
      await sendClaimed(id, now);
      run.retried++;
    } catch {
      run.failed++;
    }
  }
  const daily = pastDailyTime(now);
  for (const scope of await projectsWithPending(now)) {
    for (const kind of daily ? (["urgent", "daily"] as const) : (["urgent"] as const)) {
      const result = await deliverAlerts(scope, kind, now);
      if (result === "sent") run.sent++;
      if (result === "failed") run.failed++;
    }
  }
  if (run.failed) throw new Error(`${run.failed} alert email${run.failed === 1 ? "" : "s"} not sent; the retry tries again`);
  return run;
}
