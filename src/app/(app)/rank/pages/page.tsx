import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { chartDay } from "@/components/ui/module-card";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { pagesFigures, pagesSentence, withoutEmptyColumns } from "@/modules/rank/brief";
import { CheckNowButtons, lastCheckedLabel, PlaceNotice, placeParams, RangePicker, RankTabs, RunStatus } from "@/modules/rank/components/chrome";
import { buildPages, droppedPages } from "@/modules/rank/pages";
import { loadResultsToCarry, loadTracker, parseRange, resolveWindow } from "@/modules/rank/queries";

export const metadata = { title: "Ranking pages" };

export default async function RankPagesPage({ searchParams }: PageProps<"/rank/pages">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const [timeZone, state] = await Promise.all([currentTimeZone(), loadTracker(projectScope(project), sp.place)]);
  const win = resolveWindow(state.dates, range);
  const rows = win ? await loadResultsToCarry(projectScope(project), win.start, win.end, state.place) : [];
  const pages = buildPages(state.keywords, rows, win?.start);
  const dropped = droppedPages(state.keywords, rows, win?.start);

  const tableRows = pages.map((p) => ({
    ...p,
    path: p.url.replace(/^https?:\/\/(www\.)?/, ""),
    avgPosition: p.avgPosition == null ? null : Math.round(p.avgPosition * 10) / 10,
  }));
  const columns: ColumnSpec[] = [
    { key: "path", label: "URL", format: "link", href: `/rank?url={url}&range=${range}${state.place.current ? "" : `&place=${state.place.code}`}` },
    { key: "keywords", label: "Keywords", format: "number" },
    { key: "keywordsDelta", label: "Change", format: "delta" },
    { key: "avgPosition", label: "Tracked position", format: "position" },
    { key: "traffic", label: "Est. traffic", format: "number" },
    { key: "volume", label: "Total volume", format: "number" },
    { key: "topKeyword", label: "Best keyword" },
  ];
  const placeNotice = <PlaceNotice state={state} path="/rank/pages" params={{ range: String(range) }} className={state.place.current ? "mt-3" : undefined} />;

  return (
    <>
      <PageHeader
        title="Rankings"
        description={
          <>
            Google {state.place.name} · which {project.domain} pages rank for your tracked keywords · {lastCheckedLabel(state, timeZone)}
          </>
        }
        actions={<CheckNowButtons project={project} state={state} />}
      />
      <RankTabs />
      <RunStatus state={state} />
      {/* Reading an older place: every number below is about it, so that callout stays on top. */}
      {!state.place.current && placeNotice}
      {!pages.length || !win ? (
        <>
          <EmptyState
            title={rows.length ? "No ranking URLs" : "No results yet"}
            description={
              rows.length
                ? `None of your tracked keywords rank within the results checked (the top ${state.settings.dailyDepth} each day, the top ${state.settings.sweepDepth} in the weekly check).`
                : "Pages appear after the first check finishes."
            }
            action={<ButtonLink href="/rank">Go to overview</ButtonLink>}
          />
          {state.place.current && placeNotice}
        </>
      ) : (
        <>
          <Briefing sentence={pagesSentence(pages, dropped, win)}>
            {pagesFigures(pages, dropped, win).map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>
          {state.place.current && placeNotice}
          <Section
            title="Ranking pages"
            description={`Latest check ${chartDay(win.end)}${win.start !== win.end ? `, keyword change since ${chartDay(win.start)}` : ""}. Click a URL to filter the overview to it.`}
            actions={<RangePicker path="/rank/pages" range={range} params={placeParams(state.place)} />}
          >
            <DataTable filename="rank-pages" initialSort={{ key: "traffic", desc: true }} rows={tableRows} columns={withoutEmptyColumns(columns, tableRows, ["keywordsDelta", "avgPosition", "traffic", "volume"])} />
          </Section>
        </>
      )}
    </>
  );
}
