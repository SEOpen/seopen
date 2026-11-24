import { and, eq, inArray, max } from "drizzle-orm";
import { db } from "@/db";
import { ga4LandingDaily, googleAccounts, googleSyncState, plausibleAccounts, posthogAccounts, umamiAccounts } from "@/db/schema";
import { dataStopped, failedCheck, stoppedData, type CheckFailure } from "@/lib/check-failure";
import type { Project } from "@/lib/projects";

type Provider = NonNullable<CheckFailure["provider"]>;

/** One sync's stored state, and whether its account is broken or was connected after that sync last ran. */
export interface SyncReading {
  provider: Provider;
  /** Where the sync's numbers and its way forward are. */
  href: string;
  status: string | undefined;
  message: string | null | undefined;
  lastRunAt: Date | null | undefined;
  accountNeedsReconnect: boolean;
  /** When the account was last connected, so an older refusal doesn't outlive the fix. Null with no account. */
  connectedAt: Date | null;
  /** Which Analytics source this is. Unset for Search Console, which isn't asked whether its data stopped. */
  analytics?: Analytics;
  /** The last day the sync asked for ("YYYY-MM-DD"), and the newest day with stored data. */
  checkedThrough?: string | null;
  newestData?: string | null;
}

type Analytics = "GA4" | "PostHog" | "Plausible" | "Umami";

/** What usually stops an Analytics source sending data while its sync keeps working. */
const STOPPED_BECAUSE: Record<Analytics, string> = {
  GA4: "the GA4 tag came off the site, or this project reads the wrong GA4 property",
  PostHog: "the PostHog snippet came off the site, or this project reads the wrong PostHog project",
  Plausible: "the Plausible script came off the site, or this project reads the wrong Plausible site",
  Umami: "the Umami script came off the site, or this project reads the wrong Umami website",
};

const RECONNECT = (provider: Provider) => `${provider} stopped accepting SEOpen's access, so syncs are paused until you reconnect.`;

/** Whether a source needs a reconnect or its newest sync failed. A running, rate-limited or successful sync is neither. Pure. */
export function syncFailure(s: SyncReading, timeZone: string): CheckFailure | null {
  const refused = s.status === "reauth" && (!s.lastRunAt || !s.connectedAt || s.lastRunAt >= s.connectedAt);
  // Plausible refusing the plan is no sign-in problem, so reconnecting isn't the way forward.
  if (!s.accountNeedsReconnect && refused && s.lastRunAt && s.provider === "Plausible" && s.message && /Stats API/.test(s.message)) {
    return failedCheck({ noun: "sync", at: s.lastRunAt, timeZone, reason: s.message, retry: false, next: { label: "View", href: s.href } });
  }
  if (s.accountNeedsReconnect || refused) {
    return { kind: "reconnect", noun: "sync", at: null, day: null, reason: s.accountNeedsReconnect || !s.message ? RECONNECT(s.provider) : s.message, retry: false, next: { label: "Reconnect", href: s.href }, provider: s.provider };
  }
  if (s.status !== "error" || !s.lastRunAt) return stopped(s, timeZone);
  return failedCheck({ noun: "sync", at: s.lastRunAt, timeZone, reason: s.message || "This sync didn't finish. It tries again on its own, or use Sync now.", retry: true, next: { label: "View", href: s.href } });
}

/** "Oct 1" from "2026-10-01". */
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A sync that works but whose data stopped arriving weeks before the last day it asked for. */
function stopped(s: SyncReading, timeZone: string): CheckFailure | null {
  if (!s.analytics || !s.lastRunAt || !s.checkedThrough || !s.newestData || !dataStopped(s.checkedThrough, s.newestData)) return null;
  const reason = `SEOpen asked ${s.analytics} for every day through ${day(s.checkedThrough)}, and the newest day with organic sessions is ${day(s.newestData)}. That usually means ${STOPPED_BECAUSE[s.analytics]}.`;
  return stoppedData({ at: s.lastRunAt, timeZone, since: s.newestData, reason, next: { label: "View", href: s.href } });
}

async function accounts(workspaceId: number) {
  const [google, posthog, plausible, umami] = await Promise.all([
    db.select({ status: googleAccounts.status, connectedAt: googleAccounts.connectedAt }).from(googleAccounts).where(eq(googleAccounts.workspaceId, workspaceId)),
    db.select({ status: posthogAccounts.status, connectedAt: posthogAccounts.connectedAt }).from(posthogAccounts).where(eq(posthogAccounts.workspaceId, workspaceId)),
    db.select({ status: plausibleAccounts.status, connectedAt: plausibleAccounts.connectedAt }).from(plausibleAccounts).where(eq(plausibleAccounts.workspaceId, workspaceId)),
    db.select({ status: umamiAccounts.status, connectedAt: umamiAccounts.connectedAt }).from(umamiAccounts).where(eq(umamiAccounts.workspaceId, workspaceId)),
  ]);
  const account = (rows: { status: string; connectedAt: Date }[]) => ({ needsReconnect: rows[0]?.status === "reauth_required", connectedAt: rows[0]?.connectedAt ?? null });
  return { Google: account(google), PostHog: account(posthog), Plausible: account(plausible), Umami: account(umami) };
}

/** What each project reads for a source, or null when it has none mapped. */
type Mapping = (p: Project) => { source: string; property: string; provider: Provider; href: string; analytics?: Analytics } | null;

const searchConsole: Mapping = (p) => (p.gscProperty ? { source: "gsc", property: p.gscProperty, provider: "Google", href: "/gsc" } : null);

const analytics: Mapping = (p) =>
  p.umamiSite
    ? { source: "umami", property: p.umamiSite, provider: "Umami", href: "/ga4", analytics: "Umami" }
    : p.plausibleSite
    ? { source: "plausible", property: p.plausibleSite, provider: "Plausible", href: "/ga4", analytics: "Plausible" }
    : p.posthogProject
      ? { source: "posthog", property: p.posthogProject, provider: "PostHog", href: "/ga4", analytics: "PostHog" }
      : p.ga4Property
        ? { source: "ga4", property: p.ga4Property, provider: "Google", href: "/ga4", analytics: "GA4" }
        : null;

/** The newest day of stored Analytics data for each of these projects, one query for them all. */
async function newestAnalyticsDay(workspaceId: number, projectIds: number[]): Promise<Map<number, string>> {
  if (!projectIds.length) return new Map();
  const rows = await db
    .select({ projectId: ga4LandingDaily.projectId, newest: max(ga4LandingDaily.date) })
    .from(ga4LandingDaily)
    .where(and(eq(ga4LandingDaily.workspaceId, workspaceId), inArray(ga4LandingDaily.projectId, projectIds)))
    .groupBy(ga4LandingDaily.projectId);
  return new Map(rows.flatMap((r) => (r.newest ? [[r.projectId, r.newest] as const] : [])));
}

/** Read together: one query for the sync rows and one per kind of account, however many projects there are. */
async function failuresFor(projects: Project[], timeZone: string, mapping: Mapping): Promise<Map<number, CheckFailure>> {
  const mapped = projects.flatMap((project) => {
    const m = mapping(project);
    return m ? [{ project, ...m }] : [];
  });
  if (!mapped.length) return new Map();
  const workspaceId = projects[0].workspaceId;
  const ids = mapped.map((m) => m.project.id);
  const [account, syncs, newest] = await Promise.all([
    accounts(workspaceId),
    db
      .select({ projectId: googleSyncState.projectId, source: googleSyncState.source, property: googleSyncState.property, status: googleSyncState.status, message: googleSyncState.message, lastRunAt: googleSyncState.lastRunAt, latestDate: googleSyncState.latestDate })
      .from(googleSyncState)
      .where(and(eq(googleSyncState.workspaceId, workspaceId), inArray(googleSyncState.projectId, ids))),
    // Every Analytics source fills this table, and a project has only one of them.
    mapped.some((m) => m.analytics) ? newestAnalyticsDay(workspaceId, ids) : new Map<number, string>(),
  ]);
  const out = new Map<number, CheckFailure>();
  for (const m of mapped) {
    // A mapping change leaves the old property's row behind until its first sync, and that row says nothing about this one.
    const sync = syncs.find((s) => s.projectId === m.project.id && s.source === m.source && s.property === m.property);
    const failure = syncFailure(
      {
        provider: m.provider,
        href: m.href,
        status: sync?.status,
        message: sync?.message,
        lastRunAt: sync?.lastRunAt,
        accountNeedsReconnect: account[m.provider].needsReconnect,
        connectedAt: account[m.provider].connectedAt,
        analytics: m.analytics,
        checkedThrough: sync?.latestDate,
        newestData: newest.get(m.project.id),
      },
      timeZone,
    );
    if (failure) out.set(m.project.id, failure);
  }
  return out;
}

export const searchConsoleFailures = (projects: Project[], timeZone: string) => failuresFor(projects, timeZone, searchConsole);
export const analyticsFailures = (projects: Project[], timeZone: string) => failuresFor(projects, timeZone, analytics);
