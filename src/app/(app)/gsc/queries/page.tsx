import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { projectScope } from "@/lib/workspace";
import { dimFigures, dimSentence, gscSource } from "@/modules/google/brief";
import { LIKELY_BOT_LABEL } from "@/modules/google/bot-queries";
import { gscByQuery, gscGoneCount } from "@/modules/google/data";
import { GscBriefing, gscContext } from "@/modules/google/ui/context";
import { GscTable } from "@/modules/google/ui/gsc-table";
import { describePeriods, PeriodControls } from "@/modules/google/ui/period";
import { GscTabs } from "@/modules/google/ui/status";

export const metadata = { title: "Queries · Search Console" };

export default async function QueriesPage({ searchParams }: PageProps<"/gsc/queries">) {
  const sp = await searchParams;
  const ctx = await gscContext(sp);
  if (!ctx.ready) return ctx.view;
  const { project, periods, choice, data } = ctx;
  const [rows, gone] = await Promise.all([gscByQuery(projectScope(project), periods.current, periods.previous), periods.previous ? gscGoneCount(projectScope(project), "query", periods.current, periods.previous) : 0]);
  const cmp = !!periods.previous;
  // Searches that look like other tools' rank checks stay listed, flagged, but don't count in the figures above.
  const real = rows.filter((r) => !r.likelyBot);
  const win = { periods, compare: choice.compare, first: data.first };

  return (
    <>
      <PageHeader title="Search Console" description={gscSource(project.gscProperty, data.last)} actions={<PeriodControls path="/gsc/queries" sp={sp} choice={choice} />} />
      <GscTabs />
      <GscBriefing sentence={dimSentence(real, "query", win, gone)} figures={dimFigures(real, "query", win)} />
      <Section
        title="Queries"
        className="mt-6"
        description={`${describePeriods(periods)}. Anonymized queries are left out by Google, so these rows add up to less than the site totals. Searches that start with a number and a colon, such as "5196: rank tracker", are most likely another tool checking rankings: they're marked and left out of the totals. Click a query to see which pages rank for it.`}
      >
        <GscTable
          filename={`${project.domain}-queries`}
          initialSort={{ key: "clicks", desc: true }}
          columns={[
            { key: "key", label: "Query", format: "link", href: "/gsc/query?q={key}", flag: "botNote" },
            { key: "clicks", label: "Clicks", format: "number" },
            ...(cmp ? [{ key: "clicksDelta", label: "Clicks change", format: "count-change" as const }] : []),
            { key: "impressions", label: "Impressions", format: "number" },
            ...(cmp ? [{ key: "impressionsDelta", label: "Impressions change", format: "count-change" as const }] : []),
            { key: "ctr", label: "CTR", format: "pct" },
            { key: "position", label: "Position", format: "position" },
            ...(cmp ? [{ key: "positionDelta", label: "Position change", format: "position-change" as const }] : []),
          ]}
          rows={rows.map((r) => ({ ...r, botNote: r.likelyBot ? LIKELY_BOT_LABEL : undefined }))}
        />
      </Section>
    </>
  );
}
