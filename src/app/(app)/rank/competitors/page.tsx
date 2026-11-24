import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { chartDay } from "@/components/ui/module-card";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { getCurrentProject, listCompetitors } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { competitorFigures, competitorRows, competitorSentence, keywordsNotConfirmedNote } from "@/modules/rank/brief";
import { CheckNowButtons, lastCheckedLabel, PlaceNotice, placeParams, RangePicker, RankTabs, RunStatus } from "@/modules/rank/components/chrome";
import { DiscoveredDomainsTable, TrackedDomainsTable } from "@/modules/rank/components/competitor-tables";
import { MetricChart } from "@/modules/rank/components/metric-chart";
import { buildCompetitorView } from "@/modules/rank/competitors";
import { loadDomainResultsToCarry, loadTracker, parseRange, resolveWindow } from "@/modules/rank/queries";

export const metadata = { title: "Rankings competitors" };

export default async function RankCompetitorsPage({ searchParams }: PageProps<"/rank/competitors">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const [timeZone, state, competitors] = await Promise.all([currentTimeZone(), loadTracker(projectScope(project), sp.place), listCompetitors(projectScope(project))]);
  const win = resolveWindow(state.dates, range);
  const rows = win ? await loadDomainResultsToCarry(projectScope(project), win.start, win.end, state.place) : [];
  const v = buildCompetitorView(project.domain, competitors, state.keywords, rows, win?.start);
  // You in the series colour, everyone else thin and grey, so the eye goes to your line first.
  const series = v.domains.map((d) => (d === project.domain ? { key: d, label: `${d} (you)`, role: "primary" as const } : { key: d, label: d, role: "context" as const }));
  const count = competitors.length;
  const placeNotice = <PlaceNotice state={state} path="/rank/competitors" params={{ range: String(range) }} className={state.place.current ? "mt-3" : undefined} />;

  return (
    <>
      <PageHeader
        title="Rankings"
        description={
          <>
            Google {state.place.name} · {project.domain} against {count ? `${count} competitor${count === 1 ? "" : "s"}` : "no competitors yet"} on the same results · {lastCheckedLabel(state, timeZone)}
          </>
        }
        actions={<CheckNowButtons project={project} state={state} />}
      />
      <RankTabs hasResults={state.dates.length > 0} />
      <RunStatus state={state} />
      {/* Reading an older place: every number below is about it, so that callout stays on top. */}
      {!state.place.current && placeNotice}

      {!rows.length || !win ? (
        <>
          <EmptyState
            title="No results yet"
            description="Competitor positions come from the same Google results as your own checks, so they appear after the first check finishes."
            action={<ButtonLink href="/rank">Go to overview</ButtonLink>}
          />
          {state.place.current && placeNotice}
        </>
      ) : (
        <>
          <Briefing sentence={competitorSentence(v, project.domain, win)}>
            {competitorFigures(v, project.domain, win, `/projects/${project.id}/settings`).map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>
          {state.place.current && placeNotice}

          <Section
            title="Over time"
            description={[win.start === win.end ? `One check so far, on ${chartDay(win.end)}.` : `${chartDay(win.start)} to ${chartDay(win.end)}.`, keywordsNotConfirmedNote(v.endNotConfirmed, win.end)].filter(Boolean).join(" · ")}
            actions={<RangePicker path="/rank/competitors" range={range} params={placeParams(state.place)} />}
          >
            <MetricChart
              metrics={[
                { key: "sov", label: "Share of voice", format: "pct", data: v.seriesSov, series },
                { key: "vis", label: "Visibility", format: "pct", data: v.series, series },
                { key: "avg", label: "Tracked position", format: "position", data: v.seriesAvg, series },
              ]}
            />
          </Section>

          <Section title="Tracked domains" description={win.start === win.end ? `On ${chartDay(win.end)}.` : `On ${chartDay(win.end)}, with change since ${chartDay(win.start)}.`}>
            <TrackedDomainsTable rows={competitorRows(v, project.domain, win)} />
          </Section>

          {v.discovered.length > 0 && (
            <Section title="Other domains in these results" description={`Every other site seen in your tracked results on ${chartDay(win.end)}, by share of voice. Add the ones you compete with.`}>
              <DiscoveredDomainsTable rows={v.discovered} projectId={project.id} />
            </Section>
          )}
        </>
      )}
    </>
  );
}
