import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { BackLink } from "@/components/ui/back-link";
import { Callout } from "@/components/ui/callout";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { formatShortDate } from "@/lib/format";
import { projectScope } from "@/lib/workspace";
import { liveDaysForPage } from "@/modules/fixes/queries";
import { gscSource, totalsFigures, totalsSentence, urlPath } from "../brief";
import { likelyBotNote } from "../bot-queries";
import { dimSeries, pagesForQuery, queriesForPage, type Totals } from "../data";
import { performanceRows } from "../windowing";
import { GscBriefing, gscContext, type SP } from "./context";
import { describePeriods, PeriodControls, previousLabel } from "./period";
import { PerformanceCharts } from "./performance-charts";
import { GscTabs } from "./status";

function sum(rows: { clicks: number; impressions: number; position: number }[]): Totals {
  const clicks = rows.reduce((n, r) => n + r.clicks, 0);
  const impressions = rows.reduce((n, r) => n + r.impressions, 0);
  const posImpr = rows.reduce((n, r) => n + r.position * r.impressions, 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? posImpr / impressions : 0 };
}

/** Query → pages, or page → queries, with the item's own trend. */
export async function Drilldown({ kind, sp }: { kind: "query" | "page"; sp: SP }) {
  const value = typeof (kind === "query" ? sp.q : sp.url) === "string" ? String(kind === "query" ? sp.q : sp.url) : "";
  const ctx = await gscContext(sp, kind === "query" ? "Query" : "Page");
  if (!ctx.ready) return ctx.view;
  const { project, periods, choice, data } = ctx;
  const back = kind === "query" ? "/gsc/queries" : "/gsc/pages";
  if (!value) return <EmptyState level={1} title={`No ${kind} given`} action={<Link href={back} className="text-accent hover:underline">Back</Link>} />;

  const [series, prevSeries, rows, fixDays] = await Promise.all([
    dimSeries(projectScope(project), kind, value, periods.current),
    periods.previous ? dimSeries(projectScope(project), kind, value, periods.previous) : Promise.resolve([]),
    kind === "query" ? pagesForQuery(projectScope(project), value, periods.current) : queriesForPage(projectScope(project), value, periods.current),
    kind === "page" ? liveDaysForPage(projectScope(project), value) : Promise.resolve([]),
  ]);
  // The days a fix on this page went live, inside the period the charts show.
  const marks = fixDays.filter((m) => m.date >= periods.current.start && m.date <= periods.current.end);
  const brief = { periods, compare: choice.compare, first: data.first, cur: sum(series), prev: periods.previous ? sum(prevSeries) : null, subject: `this ${kind}` };
  const path = kind === "query" ? "/gsc/query" : "/gsc/page";
  // A page's searches that look like another tool's rank check get a Note.
  const botNotes = rows.map((r) => ("query" in r ? likelyBotNote(r.query) : undefined));
  const ranking = kind === "query" ? rows.filter((r) => r.impressions >= Math.max(10, (rows[0]?.impressions ?? 0) * 0.1)) : [];

  return (
    <>
      <BackLink href={back}>{kind === "query" ? "Queries" : "Pages"}</BackLink>
      <PageHeader
        title={kind === "query" ? value : urlPath(value)}
        description={
          <>
            {gscSource(project.gscProperty, data.last)}
            {kind === "page" && (
              <>
                {" · "}
                <a href={value} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline-offset-3 hover:underline">
                  Open page
                  <ExternalLink aria-hidden className="size-3" strokeWidth={1.5} />
                </a>
                {" · "}
                <Link href={`/fixes/refresh?url=${encodeURIComponent(value)}`} className="text-accent underline-offset-3 hover:underline">
                  Refresh this page
                </Link>
              </>
            )}
          </>
        }
        actions={<PeriodControls path={path} sp={sp} choice={choice} />}
      />
      <GscTabs />
      {ranking.length > 1 && (
        <div className="mb-4">
          <Callout tone="warn" title={`${ranking.length} pages compete for this query`}>
            Several of your pages get meaningful impressions for it. If they target the same intent, consider merging them or making one clearly the main page.
          </Callout>
        </div>
      )}
      <GscBriefing sentence={totalsSentence(brief)} figures={totalsFigures(brief)} />
      <Section title={kind === "query" ? "Pages ranking for this query" : "Queries this page ranks for"} description={describePeriods(periods)} className="mt-6">
        <DataTable
          filename={`${project.domain}-${kind}-drilldown`}
          initialSort={{ key: "clicks", desc: true }}
          columns={[
            kind === "query"
              ? { key: "page", label: "Page", format: "link", href: "/gsc/page?url={page}" }
              : { key: "query", label: "Query", format: "link", href: "/gsc/query?q={query}" },
            { key: "clicks", label: "Clicks", format: "number" },
            { key: "impressions", label: "Impressions", format: "number" },
            { key: "ctr", label: "CTR", format: "pct" },
            { key: "position", label: "Position", format: "position" },
            ...(botNotes.some(Boolean) ? [{ key: "botNote", label: "Note", format: "badge" as const }] : []),
          ]}
          rows={rows.map((r, i) => ({ ...r, botNote: botNotes[i] }))}
        />
      </Section>
      <Section title="Performance" description={describePeriods(periods)}>
        <PerformanceCharts rows={performanceRows(series, prevSeries, periods, data.first)} previousLabel={previousLabel(choice.compare)} marks={marks} markNoun="Fix live" />
        {marks.length > 0 && (
          <p className="mt-3 max-w-[72ch] text-xs text-muted">
            {marks.length === 1 ? "A fix" : "Fixes"} on this page went live in this period: {marks.map((m) => `${formatShortDate(m.date, "UTC")}, ${m.label.replace(/[.\s]+$/, "")}`).join("; ")}.{" "}
            <Link href="/fixes" className="text-accent underline-offset-3 hover:underline">
              Fixes
            </Link>
          </p>
        )}
      </Section>
    </>
  );
}
