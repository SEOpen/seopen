import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { projectScope } from "@/lib/workspace";
import { dimFigures, dimSentence, gscSource, pageLabels } from "@/modules/google/brief";
import { gscByPage, gscGoneCount } from "@/modules/google/data";
import { GscBriefing, gscContext } from "@/modules/google/ui/context";
import { GscTable } from "@/modules/google/ui/gsc-table";
import { describePeriods, PeriodControls } from "@/modules/google/ui/period";
import { GscTabs } from "@/modules/google/ui/status";

export const metadata = { title: "Pages · Search Console" };

export default async function PagesPage({ searchParams }: PageProps<"/gsc/pages">) {
  const sp = await searchParams;
  const ctx = await gscContext(sp);
  if (!ctx.ready) return ctx.view;
  const { project, periods, choice, data } = ctx;
  const [found, gone] = await Promise.all([gscByPage(projectScope(project), periods.current, periods.previous), periods.previous ? gscGoneCount(projectScope(project), "page", periods.current, periods.previous) : 0]);
  const label = pageLabels(found.map((r) => r.key));
  const rows = found.map((r) => ({ ...r, path: label(r.key) }));
  const cmp = !!periods.previous;
  const win = { periods, compare: choice.compare, first: data.first };

  return (
    <>
      <PageHeader title="Search Console" description={gscSource(project.gscProperty, data.last)} actions={<PeriodControls path="/gsc/pages" sp={sp} choice={choice} />} />
      <GscTabs />
      <GscBriefing sentence={dimSentence(rows, "page", win, gone)} figures={dimFigures(rows, "page", win)} />
      <Section title="Pages" className="mt-6" description={`${describePeriods(periods)}. Click a page to see the queries it ranks for.`}>
        <GscTable
          filename={`${project.domain}-pages`}
          initialSort={{ key: "clicks", desc: true }}
          columns={[
            { key: "path", label: "Page", format: "link", href: "/gsc/page?url={key}" },
            { key: "clicks", label: "Clicks", format: "number" },
            ...(cmp ? [{ key: "clicksDelta", label: "Clicks change", format: "count-change" as const }] : []),
            { key: "impressions", label: "Impressions", format: "number" },
            ...(cmp ? [{ key: "impressionsDelta", label: "Impressions change", format: "count-change" as const }] : []),
            { key: "ctr", label: "CTR", format: "pct" },
            { key: "position", label: "Position", format: "position" },
            ...(cmp ? [{ key: "positionDelta", label: "Position change", format: "position-change" as const }] : []),
            { key: "key", label: "URL", format: "url" },
            { key: "refresh", label: "Refresh", format: "link", href: "/fixes/refresh?url={key}" },
          ]}
          rows={rows.map((r) => ({ ...r, refresh: "Refresh this page" })) as unknown as Record<string, unknown>[]}
        />
      </Section>
    </>
  );
}
