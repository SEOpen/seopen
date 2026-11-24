import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { cannibalFigures, cannibalSentence } from "@/modules/rank/brief";
import { CannibalTable } from "@/modules/rank/components/cannibal-table";
import { CheckNowButtons, lastCheckedLabel, PlaceNotice, placeParams, RangePicker, RankTabs, RunStatus } from "@/modules/rank/components/chrome";
import { cannibalPages, findCannibalization } from "@/modules/rank/pages";
import { loadResults, loadTracker, parseRange, resolveWindow } from "@/modules/rank/queries";

export const metadata = { title: "Cannibalization" };

export default async function RankCannibalizationPage({ searchParams }: PageProps<"/rank/cannibalization">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  // URL swaps need several checks to show, so this tab defaults to 30 days.
  const sp = await searchParams;
  const range = sp.range ? parseRange(sp.range) : 30;
  const [timeZone, state] = await Promise.all([currentTimeZone(), loadTracker(projectScope(project), sp.place)]);
  const win = resolveWindow(state.dates, range);
  const rows = win ? await loadResults(projectScope(project), win.start, win.end, state.place) : [];
  const affected = findCannibalization(state.keywords, rows);
  const pages = cannibalPages(affected);
  const ranking = new Set(rows.filter((r) => r.position != null).map((r) => r.keywordId)).size;
  const ourUrls = new Set(rows.flatMap((r) => [...r.ownUrls.map((o) => o.u), ...(r.url ? [r.url] : [])])).size;
  const placeNotice = <PlaceNotice state={state} path="/rank/cannibalization" params={{ range: String(range) }} className={state.place.current ? "mt-3" : undefined} />;

  return (
    <>
      <PageHeader
        title="Rankings"
        description={<>Keywords where two or more of your own pages show up for the same search, so they compete with each other instead of one ranking well · {lastCheckedLabel(state, timeZone)}</>}
        actions={<CheckNowButtons project={project} state={state} />}
      />
      <RankTabs />
      <RunStatus state={state} />
      {/* Reading an older place: every number below is about it, so that callout stays on top. */}
      {!state.place.current && placeNotice}
      {!rows.length || !win ? (
        <>
          <EmptyState title="No results yet" description="Competing pages are found in the Google results each check saves, so they appear after the first check." action={<ButtonLink href="/rank">Go to overview</ButtonLink>} />
          {state.place.current && placeNotice}
        </>
      ) : (
        <>
          <Briefing sentence={cannibalSentence(affected.length, ranking, win)}>
            {cannibalFigures(affected, ranking, pages.length, ourUrls).map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>
          {state.place.current && placeNotice}

          <Section
            title="By keyword"
            description="A keyword counts when two of your pages rank for the same search, or the ranking page swaps between checks."
            actions={<RangePicker path="/rank/cannibalization" range={range} params={placeParams(state.place)} />}
          >
            {affected.length ? <CannibalTable rows={affected} /> : <EmptyState level={3} title="No competing pages found" description="Each ranking keyword has had one page of yours in this range." />}
          </Section>

          {pages.length > 0 && (
            <Section title="By page">
              <DataTable
                filename="cannibal-pages"
                rows={pages}
                columns={[
                  { key: "url", label: "URL", format: "url" },
                  { key: "keywords", label: "Affected keywords", format: "number" },
                  { key: "volume", label: "Volume", format: "number" },
                ]}
                initialSort={{ key: "keywords", desc: true }}
              />
            </Section>
          )}
        </>
      )}
    </>
  );
}
