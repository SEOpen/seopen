import { and, asc, count, eq, gte } from "drizzle-orm";
import { chartDay, type AnyDashboardModule } from "@/components/ui/module-card";
import { db } from "@/db";
import { fixes, projects, recapSends, users, workspaceMembers, workspaces } from "@/db/schema";
import { checkGate } from "@/lib/billing/check-gate";
import { withEndedGrant } from "@/lib/billing/gates";
import { summaryFailure } from "@/lib/check-failure";
import { emailConfigured, recapMessage, sendEmail } from "@/lib/email";
import type { Project } from "@/lib/projects";
import { SCHEDULE_TIME_ZONE } from "@/lib/schedule";
import { projectScope, workspaceTimeZone } from "@/lib/workspace";
import { dashboard as ai } from "@/modules/ai/dashboard";
import { dashboard as audit } from "@/modules/audit/dashboard";
import { fixCounts } from "@/modules/fixes/queries";
import { dashboard as google } from "@/modules/google/dashboard";
import { gscDataRange, gscStrikingPages } from "@/modules/google/data";
import { addDays, todayIn } from "@/modules/google/windowing";
import { dashboard as rank } from "@/modules/rank/dashboard";
import { listAlerts } from "@/modules/alerts/queries";
import { CLOSEST_PAGES, projectRecap, type ProjectRecap, type RecapAlert, type RecapClosest, type RecapSource } from "./content";
import { recapOpen } from "./gate";
import { emailOrigin } from "./origin";
import { unsubscribeUrl } from "./unsubscribe";

/**
 * The weekly recap email: Mondays, one email per person who turned it on, per
 * workspace they're in, with a short section for each project that has something to say. Nothing
 * goes out when no project does. A send is claimed in recap_sends first and the claim given back if
 * it fails, and Resend gets a key per person, workspace and week, so a retried job never sends twice.
 *
 * It reads the dashboard cards the MCP's what_changed reads (src/lib/mcp/data.ts), four of them
 * imported directly: that file reaches server-only modules, which the worker can't load.
 */

/** The cards a recap reads, in RECAP_MODULES order. */
const MODULES: AnyDashboardModule[] = [google, rank, ai, audit];

/** A card slower than this is left out of the recap, as the dashboard counts it failed. */
const LOAD_TIMEOUT_MS = 10_000;

const DAY_MS = 86_400_000;


/** The Monday of `now`'s week on the schedule's calendar, "YYYY-MM-DD": the week a recap is for. */
export function recapWeek(now: Date): string {
  const today = todayIn(SCHEDULE_TIME_ZONE, now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, -((weekday + 6) % 7));
}

/** Resend's idempotency key for one recap. */
export const recapKey = (workspaceId: number, userId: string, week: string) => `weekly-recap/${workspaceId}/${userId}/${week}`;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took longer than ${LOAD_TIMEOUT_MS}ms`)), LOAD_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Which projects' newest check failed, by module, through the plan as on Overview. One that can't be read counts as no failure. */
async function failingSources(live: Project[], workspaceId: number): Promise<Set<string>> {
  const out = new Set<string>();
  const [timeZone, gate] = await Promise.all([workspaceTimeZone({ workspaceId }), checkGate(workspaceId)]);
  await Promise.all(
    MODULES.map(async (module) => {
      if (!module.failures) return;
      try {
        const found = await withTimeout(module.failures(live, timeZone));
        for (const [projectId, failure] of found) if (summaryFailure(failure, gate(module.id, projectId))) out.add(`${module.id}:${projectId}`);
      } catch (err) {
        console.error(`[recap] ${module.id} couldn't read its failed checks`, err);
      }
    }),
  );
  return out;
}

/** One project's cards that loaded and whose newest check didn't fail. A card that fails to load is left out, not the recap. */
async function projectSources(project: Project, failing: Set<string>): Promise<RecapSource[]> {
  const loaded = await Promise.all(
    MODULES.map(async (module): Promise<RecapSource | null> => {
      if (failing.has(`${module.id}:${project.id}`)) return null;
      try {
        const data = await withTimeout(module.load(project));
        return data == null ? null : { module, data };
      } catch (err) {
        console.error(`[recap] ${module.id} failed to load for project ${project.id}`, err);
        return null;
      }
    }),
  );
  return loaded.filter((s): s is RecapSource => s != null);
}

async function projectFixes(project: Project, now: Date) {
  const scope = projectScope(project);
  const [counts, [fresh]] = await Promise.all([
    fixCounts(scope),
    db
      .select({ n: count() })
      .from(fixes)
      .where(and(eq(fixes.workspaceId, scope.workspaceId), eq(fixes.projectId, scope.projectId), eq(fixes.status, "open"), gte(fixes.firstSeenAt, new Date(now.getTime() - 7 * DAY_MS)))),
  ]);
  return { open: counts.open, newThisWeek: fresh?.n ?? 0 };
}

/** The pages closest to page one over the latest 28 stored days, as Opportunities groups them. None without Search Console, when its newest sync failed, or when it can't be read. */
async function projectClosest(project: Project, failing: Set<string>): Promise<RecapClosest | null> {
  if (!project.gscProperty || failing.has(`google:${project.id}`)) return null;
  const scope = projectScope(project);
  try {
    return await withTimeout(
      (async () => {
        const range = await gscDataRange(scope);
        if (!range) return null;
        const period = { start: addDays(range.last, -27), end: range.last };
        const { pages } = await gscStrikingPages(scope, period);
        return { period, pages: pages.slice(0, CLOSEST_PAGES).map((p) => ({ url: p.page, query: p.topQuery.query, position: p.topQuery.position, impressions: p.topQuery.impressions })) };
      })(),
    );
  } catch (err) {
    console.error(`[recap] pages close to page one failed to load for project ${project.id}`, err);
    return null;
  }
}

/** The project's alerts from the past 7 days, each with the day it was found in the workspace's zone. None when they can't be read. */
async function projectAlerts(project: Project, now: Date, timeZone: string): Promise<RecapAlert[]> {
  try {
    const rows = await listAlerts(projectScope(project), { since: new Date(now.getTime() - 7 * DAY_MS), limit: 50 });
    return rows.map((a) => ({ title: a.title, source: a.source, day: todayIn(timeZone, a.detectedAt), resolved: a.resolvedAt != null }));
  } catch (err) {
    console.error(`[recap] alerts failed to load for project ${project.id}`, err);
    return [];
  }
}

/** The sections of a workspace's recap: each live project with something to say, by name. */
export async function workspaceRecap(workspaceId: number, now: Date, origin = emailOrigin()): Promise<ProjectRecap[]> {
  const live = await db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.archived, false)))
    .orderBy(asc(projects.name), asc(projects.id));
  if (!live.length) return [];
  const [failing, timeZone] = await Promise.all([failingSources(live, workspaceId), workspaceTimeZone({ workspaceId })]);
  const out: ProjectRecap[] = [];
  for (const project of live) {
    const [sources, fixesNow, closest, alerts] = await Promise.all([projectSources(project, failing), projectFixes(project, now), projectClosest(project, failing), projectAlerts(project, now, timeZone)]);
    const recap = projectRecap({ project: { id: project.id, name: project.name, domain: project.domain }, sources, fixes: fixesNow, closest, alerts, now, origin });
    if (recap) out.push(recap);
  }
  return out;
}

/** Who gets a recap: people who turned it on, with a verified email, in each active workspace whose plan has it. */
async function recipients() {
  const rows = await db
    .select({ userId: users.id, email: users.email, workspaceId: workspaces.id, plan: workspaces.plan, grantedAt: workspaces.grantedAt, grantEndsAt: workspaces.grantEndsAt })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(users.weeklyRecap, true), eq(users.emailVerified, true), eq(workspaces.status, "active")))
    .orderBy(asc(workspaces.id), asc(users.id));
  return rows.filter((r) => recapOpen(withEndedGrant(r)));
}

export interface RecapRun {
  week: string;
  sent: number;
  /** Already sent this week, or nothing to say. */
  skipped: number;
  failed: number;
}

/**
 * Sends this week's recaps. Safe to run again: each person, workspace and week is claimed once, and
 * a send that fails gives its claim back for the next run. Throws after the rest are sent when any
 * failed, so the job's retry picks those up.
 */
export async function sendWeeklyRecaps(now = new Date()): Promise<RecapRun> {
  const week = recapWeek(now);
  const run: RecapRun = { week, sent: 0, skipped: 0, failed: 0 };
  // Without a key sendEmail only logs, which would use up the week's claims.
  if (!emailConfigured()) {
    console.warn("[recap] weekly recaps not sent: RESEND_API_KEY isn't set here");
    return run;
  }
  const origin = emailOrigin();
  const sections = new Map<number, Promise<ProjectRecap[]>>();
  for (const r of await recipients()) {
    if (!sections.has(r.workspaceId)) sections.set(r.workspaceId, workspaceRecap(r.workspaceId, now, origin));
    const recap = await sections.get(r.workspaceId)!;
    if (!recap.length) {
      run.skipped++;
      continue;
    }
    const [claimed] = await db.insert(recapSends).values({ workspaceId: r.workspaceId, userId: r.userId, week }).onConflictDoNothing().returning({ week: recapSends.week });
    if (!claimed) {
      run.skipped++;
      continue;
    }
    const message = recapMessage({
      sections: recap.map((s) => ({ name: s.project.name, domain: s.project.domain, href: s.href, lines: s.lines, closest: s.closest, alerts: s.alerts })),
      weekTo: chartDay(todayIn(SCHEDULE_TIME_ZONE, now)),
      appUrl: origin,
      settingsUrl: `${origin}/settings`,
      unsubscribeUrl: unsubscribeUrl(origin, r.userId),
    });
    try {
      await sendEmail({ to: r.email, ...message }, { idempotencyKey: recapKey(r.workspaceId, r.userId, week) });
      run.sent++;
    } catch (err) {
      console.error(`[recap] recap for workspace ${r.workspaceId} not sent:`, err instanceof Error ? err.message : err);
      await db.delete(recapSends).where(and(eq(recapSends.workspaceId, r.workspaceId), eq(recapSends.userId, r.userId), eq(recapSends.week, week)));
      run.failed++;
    }
  }
  if (run.failed) throw new Error(`${run.failed} weekly recap${run.failed === 1 ? "" : "s"} not sent (${run.sent} sent); the retry sends the rest`);
  return run;
}
