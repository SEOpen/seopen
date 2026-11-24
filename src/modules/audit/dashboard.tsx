import { compare, Kpi, KpiRow, ModuleNote, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { countDeltaFromZero } from "@/lib/brief";
import { formatDate, formatNumber } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope, workspaceTimeZone } from "@/lib/workspace";
import { activeCrawl, getSettings } from "./crawl";
import { auditFailure } from "./failure";
import { doneCrawls, newestCrawls, pagesWithErrors } from "./queries";
import { scorePoints } from "./score";

export interface AuditDashboardData {
  /** The workspace's zone, which `finishedAt` reads in. */
  timeZone: string;
  /** Latest finished crawl, or null while the first crawl is still running. */
  latest: {
    /** ISO timestamp. */
    finishedAt: string;
    pages: number;
    score: number | null;
    errors: number | null;
    warnings: number | null;
    notices: number | null;
    /** Pages with at least one error. `errors` counts issues, and one page can have several. */
    pagesWithErrors: number;
  } | null;
  /** Latest minus the crawl before it, the score in whole points. Null when there is no earlier finished crawl. */
  changes: {
    score: number | null;
    errors: number | null;
    warnings: number | null;
    notices: number | null;
    pagesWithErrors: number;
    /** Pages crawled, latest minus before: a crawl that covers more pages finds more issues, so the baseline names the earlier count. */
    pages?: number;
  } | null;
  /** The crawl in progress, if any. */
  running: { pagesCrawled: number; maxPages: number } | null;
  /** Whether the weekly re-crawl is turned on, which it isn't by default. */
  weekly: boolean;
}

const diff = (a: number | null, b: number | null) => (a != null && b != null ? a - b : null);

/** Latest finished crawl against the one before, plus any running crawl. Database reads only. */
async function load(project: Project): Promise<AuditDashboardData | null> {
  const [crawls, running] = await Promise.all([doneCrawls(projectScope(project), 2), activeCrawl(projectScope(project))]);
  const [latest, previous] = crawls;
  if (!latest && !running) return null;
  const [errorPages, settings] = await Promise.all([pagesWithErrors(crawls), getSettings(projectScope(project))]);
  const pagesOf = (crawl: (typeof crawls)[number]) => errorPages.get(crawl.id) ?? 0;
  return {
    timeZone: await workspaceTimeZone(project),
    latest: latest
      ? {
          finishedAt: (latest.finishedAt ?? latest.createdAt).toISOString(),
          pages: latest.pagesCrawled,
          score: latest.healthScore,
          errors: latest.errors,
          warnings: latest.warnings,
          notices: latest.notices,
          pagesWithErrors: pagesOf(latest),
        }
      : null,
    changes:
      latest && previous
        ? {
            score: latest.healthScore != null && previous.healthScore != null ? scorePoints(latest.healthScore, previous.healthScore) : null,
            errors: diff(latest.errors, previous.errors),
            warnings: diff(latest.warnings, previous.warnings),
            notices: diff(latest.notices, previous.notices),
            pagesWithErrors: pagesOf(latest) - pagesOf(previous),
            pages: latest.pagesCrawled - previous.pagesCrawled,
          }
        : null,
    running: running ? { pagesCrawled: running.pagesCrawled, maxPages: running.maxPages } : null,
    weekly: settings.weeklyEnabled,
  };
}

function describe(d: AuditDashboardData) {
  if (!d.latest) return "Crawl running, no results yet";
  return `Crawled ${formatDate(d.latest.finishedAt, d.timeZone)} · ${formatNumber(d.latest.pages)} pages`;
}

/** "previous crawl", with its page count when it covered a different number of pages, since issue counts grow with pages. */
function baseline(d: AuditDashboardData) {
  if (!d.changes) return null;
  const pages = before(d.latest?.pages, d.changes.pages);
  return d.changes.pages && pages != null ? `previous crawl of ${formatNumber(pages)} ${pages === 1 ? "page" : "pages"}` : "previous crawl";
}

/** The previous crawl's value, rebuilt from the latest and the stored difference. */
const before = (now: number | null | undefined, change: number | null | undefined) => (now == null || change == null ? null : now - change);

function changes({ latest: l, changes: c }: AuditDashboardData) {
  return [
    compare("Health score", l?.score, before(l?.score, c?.score), { unit: "decimal", format: (n) => String(Math.round(n)) }),
    compare("Errors", l?.errors, before(l?.errors, c?.errors), { count: true, goodWhen: "down" }),
    compare("Warnings", l?.warnings, before(l?.warnings, c?.warnings), { count: true, goodWhen: "down" }),
    compare("Notices", l?.notices, before(l?.notices, c?.notices), { count: true, goodWhen: "down" }),
  ];
}

/** A count and its stored difference as a delta, in the same form as the audit page and "What changed". Fewer is better. */
const delta = (now: number | null | undefined, change: number | null | undefined) => (now == null || change == null ? null : countDeltaFromZero(now, now - change, "down"));

function View({ data: d }: { data: AuditDashboardData }) {
  const l = d.latest;
  const c = d.changes;
  return (
    <>
      <ModuleSection>
        <KpiRow>
          <Kpi label="Errors" value={formatNumber(l?.errors)} delta={delta(l?.errors, c?.errors)} />
          <Kpi label="Warnings" value={formatNumber(l?.warnings)} delta={delta(l?.warnings, c?.warnings)} />
          <Kpi label="Notices" value={formatNumber(l?.notices)} delta={delta(l?.notices, c?.notices)} />
        </KpiRow>
      </ModuleSection>
      {d.running && (
        <ModuleSection>
          <ModuleNote live>
            Crawl running: {formatNumber(d.running.pagesCrawled)} of {formatNumber(d.running.maxPages)} pages
          </ModuleNote>
        </ModuleSection>
      )}
    </>
  );
}

/** Projects whose newest crawl failed, read together. Database reads only. */
async function failures(projects: Project[], timeZone: string) {
  const crawls = await newestCrawls(projects[0].workspaceId, projects.map((p) => p.id));
  return new Map(crawls.flatMap((crawl) => {
    const failure = auditFailure(crawl, crawl.projectId, timeZone);
    return failure ? [[crawl.projectId, failure] as const] : [];
  }));
}

export const dashboard: DashboardModule<AuditDashboardData> = {
  id: "audit",
  label: "Site audit",
  href: "/audit",
  setup: { text: "no crawl yet", href: "/audit" },
  load,
  failures,
  describe,
  baseline,
  changes,
  View,
};
