import Link from "next/link";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { formatNumber, formatRate } from "@/lib/format";
import { projectScope } from "@/lib/workspace";
import { LIKELY_BOT_LABEL } from "@/modules/google/bot-queries";
import { gscSource, pageLabels, totalsFigures, totalsSentence } from "@/modules/google/brief";
import { gscByPage, gscByQuery, gscSeries, gscTotals } from "@/modules/google/data";
import { GscBriefing, gscContext } from "@/modules/google/ui/context";
import { PropertyMapping } from "@/modules/google/ui/mapping";
import { describePeriods, PeriodControls, previousLabel } from "@/modules/google/ui/period";
import { PerformanceCharts } from "@/modules/google/ui/performance-charts";
import { ConnectionPanel, GscTabs, SyncStatus } from "@/modules/google/ui/status";
import { performanceRows } from "@/modules/google/windowing";

export const metadata = { title: "Search Console" };

export default async function GscPage({ searchParams }: PageProps<"/gsc">) {
  const sp = await searchParams;
  const ctx = await gscContext(sp);
  if (!ctx.ready) return ctx.view;
  const { project, periods, choice, connection, data } = ctx;

  const [cur, prev, series, prevSeries, queries, pages] = await Promise.all([
    gscTotals(projectScope(project), periods.current),
    periods.previous ? gscTotals(projectScope(project), periods.previous) : null,
    gscSeries(projectScope(project), periods.current),
    periods.previous ? gscSeries(projectScope(project), periods.previous) : [],
    gscByQuery(projectScope(project), periods.current, null, { limit: 10 }),
    gscByPage(projectScope(project), periods.current, null, { limit: 10 }),
  ]);
  const brief = { periods, compare: choice.compare, first: data.first, cur, prev };

  return (
    <>
      <PageHeader title="Search Console" description={gscSource(project.gscProperty, data.last)} actions={<PeriodControls path="/gsc" sp={sp} choice={choice} />} />
      <GscTabs />
      <GscBriefing sentence={totalsSentence(brief)} figures={totalsFigures(brief)} />
      <Section title="Performance" description={describePeriods(periods)} className="mt-6">
        <PerformanceCharts rows={performanceRows(series, prevSeries, periods, data.first)} previousLabel={previousLabel(choice.compare)} />
      </Section>
      <div className="mt-8 grid items-start gap-x-8 gap-y-8 @3xl/main:grid-cols-2">
        <TopList title="Top queries" noun="Query" href="/gsc/queries" allLabel="All queries" rows={queries} link={(k) => `/gsc/query?q=${encodeURIComponent(k)}`} />
        <TopList title="Top pages" noun="Page" href="/gsc/pages" allLabel="All pages" rows={pages} link={(k) => `/gsc/page?url=${encodeURIComponent(k)}`} strip />
      </div>
      <div className="mt-10 flex flex-col gap-6">
        <SyncStatus project={project} />
        <ConnectionPanel connection={connection} sp={sp} />
        <Suspense fallback={<div className="panel h-40" />}>
          <PropertyMapping currentProjectId={project.id} />
        </Suspense>
      </div>
    </>
  );
}

function TopList({
  title,
  noun,
  href,
  allLabel,
  rows,
  link,
  strip,
}: {
  title: string;
  noun: string;
  href: string;
  allLabel: string;
  rows: { key: string; clicks: number; impressions: number; ctr: number; position: number; likelyBot?: true }[];
  link: (key: string) => string;
  strip?: boolean;
}) {
  const label = pageLabels(rows.map((r) => r.key));
  return (
    <Section
      title={title}
      className="mt-0 min-w-0"
      actions={
        <Link href={href} className="text-xs text-accent underline-offset-3 hover:underline">
          {allLabel}
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-secondary">None in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] table-fixed text-sm">
            <thead className="table-head">
              <tr>
                <th scope="col" className="h-9 pr-3 text-left font-medium">{noun}</th>
                <th scope="col" className="h-9 w-16 px-3 text-right font-medium">Clicks</th>
                <th scope="col" className="h-9 w-24 px-3 text-right font-medium">Impressions</th>
                <th scope="col" className="h-9 w-16 px-3 text-right font-medium">CTR</th>
                <th scope="col" className="h-9 w-20 pl-3 text-right font-medium">Position</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line-soft">
                  <td className="py-2 pr-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link href={link(r.key)} className="truncate underline-offset-4 hover:underline" title={r.key}>
                        {strip ? label(r.key) : r.key}
                      </Link>
                      {r.likelyBot && <Badge className="shrink-0">{LIKELY_BOT_LABEL}</Badge>}
                    </div>
                  </td>
                  <td className="data px-3 py-2 text-right">{formatNumber(r.clicks)}</td>
                  <td className="data px-3 py-2 text-right text-muted">{formatNumber(r.impressions)}</td>
                  <td className="data px-3 py-2 text-right text-muted">{formatRate(r.ctr)}</td>
                  <td className="data py-2 pl-3 text-right text-muted">{r.position.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
