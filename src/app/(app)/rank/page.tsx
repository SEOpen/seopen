import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { FilterBar } from "@/components/ui/filter-bar";
import { Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PlanFeature, PlanFeatureCard } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { isFree, showsDollarCosts } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { noResultsBecause } from "@/lib/check-failure";
import { formatNumber, formatPct } from "@/lib/format";
import { trackedPlaceName } from "@/lib/dataforseo/locations";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { zonedJobTime } from "@/lib/schedule";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { listBusinesses } from "@/modules/local/queries";
import { firstCheckSentence, pointsNotConfirmed, rankFigures, rankSentence, trendNote } from "@/modules/rank/brief";
import { AddKeywordsForm } from "@/modules/rank/components/add-keywords";
import { CheckNowButtons, lastCheckedLabel, latestFailure, PlaceNotice, placeParams, RangePicker, RankTabs, RunStatus } from "@/modules/rank/components/chrome";
import { MetricChart, type ChartMetric } from "@/modules/rank/components/metric-chart";
import { RankingsTable } from "@/modules/rank/components/rankings-table";
import { featureLabel } from "@/modules/rank/features";
import { BUCKETS, volumeCostNote } from "@/modules/rank/metrics";
import { briefingKind, buildOverview, parseFilters, type Overview } from "@/modules/rank/overview";
import { listSavedLists, loadDepthHint, loadResultsToCarry, loadTracker, parseRange, resolveWindow, type SavedList } from "@/modules/rank/queries";
import { searchConsoleAverages } from "@/modules/rank/search-console";

export const metadata = { title: "Rankings" };

export default async function RankPage({ searchParams }: PageProps<"/rank">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const filters = parseFilters(sp);
  const [ws, spend, timeZone, state, lists] = await Promise.all([currentWorkspace(), spendState(project.workspaceId), currentTimeZone(), loadTracker(projectScope(project), sp.place), listSavedLists(projectScope(project))]);
  const showCost = showsDollarCosts(ws);
  // Free has no rank tracking: it's told so, not shown a form that refuses what it's given.
  const free = isFree(ws);
  const win = resolveWindow(state.dates, range);
  const results = win ? await loadResultsToCarry(projectScope(project), win.start, win.end, state.place) : [];
  // A listing's city is worth pointing out while the tracker still searches the whole country.
  const [listing] = project.cityCode ? [] : await listBusinesses(projectScope(project));
  const averages = win ? await searchConsoleAverages(projectScope(project), state.keywords.map((k) => k.keyword), win.end) : undefined;
  const o = buildOverview(state.keywords, results, filters, averages, win?.start);
  const active = state.keywords.filter((k) => k.active).length;
  const devices = [...new Set(state.keywords.map((k) => k.device))].join(" + ") || "desktop";
  const filterParams = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as Record<string, string>;
  const placeQuery = placeParams(state.place);
  const filterCount = Object.keys(filterParams).length;
  // A filter can leave nothing to summarise. The top of the page then falls back on every keyword, and says so.
  const all = filterCount ? buildOverview(state.keywords, results, {}, averages, win?.start) : o;
  const briefing = briefingKind(o, all);
  // Keywords with no position that Search Console has deeper than the daily check reads: said once, under the readouts.
  const depthHint = win ? await loadDepthHint(projectScope(project), state, all.rows, win.end) : null;
  const failure = state.place.current ? latestFailure(state, timeZone) : null;
  const checkFailed = !!failure;
  const clearHref = `/rank?range=${range}${placeQuery.place ? `&place=${placeQuery.place}` : ""}`;
  const placeNotice = <PlaceNotice state={state} path="/rank" params={{ range: String(range) }} className={state.place.current ? "mt-3" : undefined} />;
  // Notes on where the checks searched from go under the readouts, so the sentence comes first under the tabs.
  const placeNotes = (
    <>
      {state.place.current && placeNotice}
      {listing && !state.places.some((p) => !p.current && p.checks > 0) && (
        <p className="mt-3 text-xs text-muted">
          Your Local SEO listing is in {listing.city}, but these checks search from all of {state.place.name}, so local searches can look worse here than in Search Console.{" "}
          <Link href={`/projects/${project.id}/settings`} prefetch={false} className="text-accent hover:underline">
            Choose a city in Project settings
          </Link>
          .
        </p>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title="Rankings"
        description={
          <>
            Google {state.place.name} · {devices} · {formatNumber(active)} keyword{active === 1 ? "" : "s"} · {free && !state.lastRun ? "not checked on the Free plan" : lastCheckedLabel(state, timeZone)}
          </>
        }
        actions={
          <>
            {active > 0 && <RangePicker path="/rank" range={range} params={{ ...filterParams, ...placeQuery }} />}
            <CheckNowButtons project={project} state={state} />
          </>
        }
      />
      <RankTabs hasResults={state.dates.length > 0} />
      <RunStatus state={state} />
      {/* Reading an older place is different: every number below is about it, so that callout stays on top. */}
      {!state.place.current && placeNotice}

      {!active && free ? (
        <PlanFeature module="rank" />
      ) : !active ? (
        <>
          <div className="module-rail">
            <EmptyState
              title="No keywords tracked yet"
              description={`Paste the keywords you want to follow for ${project.domain}, or add a saved keyword list. Each one is looked up on Google every day at ${zonedJobTime("06:00", timeZone)} (the top ${state.settings.dailyDepth} results), with a deeper weekly check that also records Google's AI answers.`}
            />
            <AddKeywords projectId={project.id} lists={lists} showCost={showCost} city={project.cityCode != null} />
          </div>
          {placeNotes}
        </>
      ) : (
        <>
          {briefing === "no-checks" ? (
            <Briefing sentence={failure ? noResultsBecause(failure) : firstCheckSentence({ running: !!state.activeRun, refused: !!spend.refusal, free, time: zonedJobTime("06:00", timeZone) })} />
          ) : (
            <Briefing
              sentence={
                briefing === "results" ? (
                  rankSentence(o, { newerFailed: checkFailed })
                ) : (
                  <>
                    {briefing === "no-match" ? "No keywords match this filter" : "The keywords in this filter haven't been checked yet"}, so the numbers below cover all your keywords.{" "}
                    <Link href={clearHref} className="text-accent hover:underline">
                      Clear the filter
                    </Link>
                  </>
                )
              }
            >
              {rankFigures(briefing === "results" ? o : all).map((f) => (
                <FigureView key={f.id} data={f} />
              ))}
            </Briefing>
          )}
          {briefing !== "no-checks" && <AlsoCounted o={briefing === "results" ? o : all} />}
          {depthHint && (
            <p className="mt-3 max-w-[69ch] text-xs text-muted">
              {depthHint.message}
              {depthHint.suggestedDepth != null && (
                <>
                  {" "}
                  <Link href="/rank/settings" className="text-accent hover:underline">
                    Change the daily check depth
                  </Link>
                  .
                </>
              )}
            </p>
          )}
          {placeNotes}

          <Filters o={o} range={range} filters={filterParams} place={placeQuery.place} clearHref={clearHref} />
          {briefing === "results" && filterCount > 0 && (
            <p className="mb-2 text-xs text-muted">
              Filtered to {o.rows.length} of {o.totalRows} keywords. The numbers above follow the filter.
            </p>
          )}
          <RankingsTable rows={o.rows} projectId={project.id} checkFailed={checkFailed} volumePlace={trackedPlaceName(project)} linkParams={{ range: String(range), ...(placeQuery.place ? { place: placeQuery.place } : {}) }} />

          {o.series.length > 0 && (
            <Section title="Trend" description={[`${o.improved} improved · ${o.declined} declined in this range`, trendNote(o.end)].filter(Boolean).join(" · ")}>
              <MetricChart metrics={chartMetrics(o)} />
            </Section>
          )}

          <div className="mt-8 grid items-start gap-6 @3xl/main:grid-cols-2">
            {free ? <PlanFeatureCard title="Add keywords" module="rank" /> : <AddKeywords projectId={project.id} lists={lists} showCost={showCost} city={project.cityCode != null} />}
            <Card>
              <CardHeader title="How these numbers work" />
              <CardBody className="space-y-2 text-sm text-secondary">
                <p>
                  <strong className="font-medium text-fg">Visibility</strong> is the share of clicks your positions would get, where 100% means ranking #1 for every keyword. Each keyword counts the same, however often it&apos;s searched.
                </p>
                <p>
                  <strong className="font-medium text-fg">Est. traffic</strong> is the visits a month your positions would bring: how often each keyword is searched, times the share of searchers who usually click that position.
                </p>
                <p>
                  <strong className="font-medium text-fg">Share of voice</strong> is visibility weighted by how often each keyword is searched: your share of all clicks on the first two pages of Google for these keywords. Compare sites on the{" "}
                  <Link href="/rank/competitors" className="text-accent hover:underline">
                    Competitors
                  </Link>{" "}
                  tab.
                </p>
                <p>Tracked position only counts keywords where your site shows up in the results checked.</p>
                {o.features.length > 0 && (
                  <p>
                    <strong className="font-medium text-fg">Result features</strong> are the extras on a results page beyond the usual links, like People also ask, videos or a map.
                  </p>
                )}
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/** The counts the strip leaves out, kept quiet so they don't compete with it. */
function AlsoCounted({ o }: { o: Overview }) {
  const end = o.end!;
  // The note says how much of a number rests on positions no look confirmed, at the number's own precision.
  const items: [string, string, string?][] = [
    ["Top 3", formatNumber(end.top3)],
    ["Top 20", formatNumber(end.top20)],
    ["Share of voice", formatPct(end.shareOfVoice, 2), pointsNotConfirmed(end.shareOfVoiceNotConfirmed, 2)],
  ];
  if (o.ai) items.push(["AI Overviews citing you", `${o.ai.cited} of ${o.ai.present}`]);
  return (
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
      {items.map(([label, value, note]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt>{label}</dt>
          <dd className="data text-fg">{value}</dd>
          {note && <dd>{note}</dd>}
        </div>
      ))}
    </dl>
  );
}

function chartMetrics(o: Overview): ChartMetric[] {
  const series = (key: string, label: string) => [{ key, label }];
  // On one check the readouts already give these counts, so three "chart starts next time" notes add nothing.
  const buckets: ChartMetric[] =
    o.series.length > 1
      ? [
          {
            key: "buckets",
            label: "Top 3, 10, 20",
            format: "number",
            // Best bucket strongest. The widest is context, on the same edge as competitors.
            series: [
              { key: "top3", label: "Top 3", role: "entity", color: "var(--ordinal-1)" },
              { key: "top10", label: "Top 10", role: "entity", color: "var(--ordinal-2)" },
              { key: "top20", label: "Top 20", role: "entity", color: "var(--line-strong)" },
            ],
            data: o.series.map((s) => ({ date: s.date, top3: s.top3, top10: s.top10, top20: s.top20 })),
          },
        ]
      : [];
  return [
    { key: "visibility", label: "Visibility", format: "pct", series: series("visibility", "Visibility"), data: o.series.map((s) => ({ date: s.date, visibility: s.visibility })) },
    { key: "sov", label: "Share of voice", format: "pct", series: series("sov", "Share of voice"), data: o.series.map((s) => ({ date: s.date, sov: s.shareOfVoice })) },
    { key: "traffic", label: "Est. traffic", format: "number", series: series("traffic", "Est. traffic"), data: o.series.map((s) => ({ date: s.date, traffic: Math.round(s.traffic) })) },
    { key: "avg", label: "Tracked position", format: "position", series: series("avg", "Tracked position"), data: o.series.map((s) => ({ date: s.date, avg: s.avgPosition })) },
    ...buckets,
  ];
}

/** GET form, so filtered views are plain links that survive reloads. */
function Filters({ o, range, filters, place, clearHref }: { o: Overview; range: number; filters: Record<string, string>; place?: string; clearHref: string }) {
  return (
    <FilterBar action="/rank" className="mt-6" fold={{ active: Object.keys(filters).length }}>
      <input type="hidden" name="range" value={range} />
      {place && <input type="hidden" name="place" value={place} />}
      {filters.url && <input type="hidden" name="url" value={filters.url} />}
      <Label>
        Position
        <Select name="bucket" defaultValue={filters.bucket ?? ""} className="h-8 text-xs">
          <option value="">Any</option>
          {BUCKETS.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        Change
        <Select name="change" defaultValue={filters.change ?? ""} className="h-8 text-xs">
          <option value="">Any</option>
          <option value="moved">Moved</option>
          <option value="improved">Improved</option>
          <option value="declined">Declined</option>
          <option value="new">New</option>
          <option value="lost">Lost</option>
          <option value="unchanged">Unchanged</option>
        </Select>
      </Label>
      {o.tags.length > 0 && (
        <Label>
          Tag
          <Select name="tag" defaultValue={filters.tag ?? ""} className="h-8 text-xs">
            <option value="">Any</option>
            {o.tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Label>
      )}
      {o.features.length > 0 && (
        <Label>
          Result features
          <Select name="feature" defaultValue={filters.feature ?? ""} className="h-8 text-xs">
            <option value="">Any</option>
            <option value="owned-any">We appear in a feature</option>
            {o.features.map((f) => (
              <option key={f} value={f}>
                {featureLabel(f)}
              </option>
            ))}
          </Select>
        </Label>
      )}
      <Label>
        AI Overview
        <Select name="aio" defaultValue={filters.aio ?? ""} className="h-8 text-xs">
          <option value="">Any</option>
          <option value="cited">We&apos;re cited</option>
          <option value="present">Has an AI Overview</option>
          <option value="absent">No AI Overview</option>
        </Select>
      </Label>
      {Object.keys(filters).length > 0 && (
        // A fixed cap, because a percentage doesn't count towards the row's minimum width and a long URL would still widen the page.
        <ButtonLink href={clearHref} title={filters.url} size="sm" variant="ghost" className="h-8 max-w-72">
          <span className="min-w-0 truncate">Clear{filters.url ? ` (URL: ${filters.url.replace(/^https?:\/\/(www\.)?/, "")})` : ""}</span>
        </ButtonLink>
      )}
    </FilterBar>
  );
}

function AddKeywords({ projectId, lists, showCost, city }: { projectId: number; lists: SavedList[]; showCost: boolean; city: boolean }) {
  return (
    <Card>
      <CardHeader title="Add keywords" description={`One per line or comma separated, or pick a saved list from Keyword research. Volumes load in the background${showCost ? ` (${volumeCostNote(city)})` : ""}.`} />
      <CardBody>
        <AddKeywordsForm projectId={projectId} lists={lists} />
      </CardBody>
    </Card>
  );
}
