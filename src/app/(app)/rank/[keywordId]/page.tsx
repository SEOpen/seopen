import { notFound } from "next/navigation";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { BackLink } from "@/components/ui/back-link";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { FilterBar } from "@/components/ui/filter-bar";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { Trend } from "@/components/ui/trend";
import { trackedPlaceName } from "@/lib/dataforseo/locations";
import { formatDay } from "@/lib/format";
import { getCurrentProject, listCompetitors } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { currentTimeZone } from "@/lib/workspace/current";
import { removeKeywordAndReturn, setKeywordTags } from "@/modules/rank/actions";
import { checkHistoryRow, googleResultsDescription, keywordCheckedLabel, keywordFigures, keywordSentence, keywordVolume, positionHistory, withoutEmptyColumns } from "@/modules/rank/brief";
import { PlaceNotice, placeParams, RangePicker } from "@/modules/rank/components/chrome";
import { MetricChart } from "@/modules/rank/components/metric-chart";
import { featureLabel } from "@/modules/rank/features";
import { matchesDomain } from "@/modules/rank/parse";
import { carryDeepPositions, RECENT_DAYS } from "@/modules/rank/recheck";
import { domainPosition, getKeyword, keywordHistory, loadPlaces, parseRange, shiftDate } from "@/modules/rank/queries";
import { searchConsoleAverages } from "@/modules/rank/search-console";

export const metadata = { title: "Keyword" };

export default async function RankKeywordPage({ params, searchParams }: PageProps<"/rank/[keywordId]">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const id = Number((await params).keywordId);
  const keyword = Number.isInteger(id) ? await getKeyword(projectScope(project), id) : null;
  if (!keyword) notFound();
  const sp = await searchParams;
  const range = sp.range ? parseRange(sp.range) : 90;
  const [competitors, timeZone] = await Promise.all([listCompetitors(projectScope(project)), currentTimeZone()]);
  const places = await loadPlaces(projectScope(project), sp.place);
  const since = shiftDate(new Date().toISOString().slice(0, 10), -range);
  // From further back, so a deep position can be carried into the first check in the range.
  const carryFrom = await keywordHistory(keyword, shiftDate(since, -RECENT_DAYS), places.place);
  const history = carryFrom.filter((h) => h.date >= since);
  const latest = history[history.length - 1] ?? null;
  const snapDate = typeof sp.date === "string" ? sp.date : latest?.date;
  const snap = history.find((h) => h.date === snapDate) ?? latest;
  const ranked = history.filter((h) => h.position != null).map((h) => h.position!);
  const best = ranked.length ? Math.min(...ranked) : null;
  // The figures read through a shallow check; the chart and the table show what each check saw.
  const read = carryDeepPositions(carryFrom, since);
  // Only a keyword no look found gets Search Console's word beside it.
  const averages = latest && read[read.length - 1].position == null ? await searchConsoleAverages(projectScope(project), [keyword.keyword], latest.date) : undefined;
  const ai = history.findLast((h) => h.aiOverviewLoaded) ?? null;

  const chartData = history.map((h) => {
    const row: Record<string, string | number | null> = { date: h.date, [project.domain]: h.position };
    for (const d of competitors) row[d] = domainPosition(h.domains, d)?.p ?? null;
    return row;
  });
  // A competitor who never appeared in this range would only add to the legend.
  const seen = competitors.filter((d) => chartData.some((r) => r[d] != null));
  const yours = history.map((h) => ({ date: h.date, value: h.position }));
  const { withRivals, description } = positionHistory(yours, seen.map((d) => history.map((h) => ({ date: h.date, value: domainPosition(h.domains, d)?.p ?? null }))));
  const placeNotice = <PlaceNotice state={places} path={`/rank/${id}`} params={{ range: String(range) }} className={places.place.current ? "mt-3" : undefined} />;

  const checkRows = history.map(checkHistoryRow);
  const checkColumns: ColumnSpec[] = [
    { key: "date", label: "Date", format: "date" },
    { key: "position", label: "Position", format: "position" },
    { key: "seen", label: "Seen", format: "badge" },
    { key: "url", label: "URL", format: "url" },
    { key: "urls", label: "Your pages", format: "number" },
    { key: "features", label: "Result features" },
    { key: "aio", label: "AI Overview", format: "badge" },
    { key: "depth", label: "Depth", format: "number" },
  ];

  return (
    <>
      <BackLink href="/rank">Rankings</BackLink>
      <PageHeader
        title={keyword.keyword}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              Google {places.place.name} · {keyword.device} · {keywordVolume(keyword.searchVolume, trackedPlaceName(project))}
              {keyword.difficulty != null && ` · difficulty ${keyword.difficulty}`}
              {latest && ` · ${keywordCheckedLabel(latest, timeZone)}`}
            </span>
            {!keyword.active && <Badge tone="warn">paused</Badge>}
          </span>
        }
        actions={
          <>
            <ButtonLink href={`/keywords?q=${encodeURIComponent(keyword.keyword)}`} variant="secondary">
              Research keyword
            </ButtonLink>
            <ActionForm action={removeKeywordAndReturn.bind(null, project.id, id)} align="end">
              <ConfirmSubmit variant="danger" size="md" confirmLabel="Stop tracking" question="Stop tracking this keyword and delete its history?">
                Stop tracking
              </ConfirmSubmit>
            </ActionForm>
          </>
        }
      />

      {/* Reading an older place: every number below is about it, so that callout stays on top. */}
      {!places.place.current && placeNotice}

      <Briefing sentence={keywordSentence(read, averages?.get(keyword.keyword.toLowerCase()))}>
        {keywordFigures(read, best, ai, range).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      {places.place.current && placeNotice}

      <Section
        title="Position history"
        description={description}
        actions={<RangePicker path={`/rank/${id}`} range={range} params={placeParams(places.place)} />}
      >
        {withRivals ? (
          <MetricChart
            metrics={[
              {
                key: "pos",
                label: "Tracked position",
                format: "position",
                data: chartData,
                series: [{ key: project.domain, label: `${project.domain} (you)`, role: "primary" }, ...seen.map((d) => ({ key: d, label: d, role: "context" as const }))],
              },
            ]}
          />
        ) : (
          <Trend
            points={yours}
            label="Tracked position"
            position
            misses
            format="position"
            noun="check"
            empty={<p className="text-sm text-secondary">{history.length ? "Not found in any check in this range." : "No checks in this range."}</p>}
          />
        )}
      </Section>

      <Section
        title="Google results"
        description={snap ? googleResultsDescription(snap, timeZone) : undefined}
        actions={
          history.length > 1 ? (
            <FilterBar className="mb-0 items-center">
              <input type="hidden" name="range" value={range} />
              {!places.place.current && <input type="hidden" name="place" value={places.place.code} />}
              <Label className="flex-row items-center font-normal text-muted">
                <span className="text-xs">Check</span>
                <Select name="date" defaultValue={snap?.date} className="h-8 text-xs">
                  {[...history].reverse().map((h) => (
                    <option key={h.date} value={h.date}>
                      {formatDay(h.date)}
                    </option>
                  ))}
                </Select>
              </Label>
              <Button size="sm" variant="secondary" type="submit" className="h-8">
                Show
              </Button>
            </FilterBar>
          ) : null
        }
      >
        {!snap ? (
          <EmptyState level={3} title="Not checked yet" description="The results appear after the first check." />
        ) : (
          <>
            {snap.serpFeatures.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
                <span className="mr-1 text-muted">Also on the page:</span>
                {snap.serpFeatures.map((f) => (
                  <Badge key={f} tone={snap.ownedFeatures.includes(f) ? "accent" : "neutral"}>
                    {featureLabel(f)}
                    {snap.ownedFeatures.includes(f) && " · you"}
                  </Badge>
                ))}
              </div>
            )}
            <ol className="divide-y divide-line-soft border-y border-line-soft text-sm">
              {snap.top.map((t, i) => {
                const ours = t.domain && matchesDomain(t.domain, project.domain);
                const comp = t.domain && competitors.find((c) => matchesDomain(t.domain, c));
                const organic = t.type === "organic";
                return (
                  <li key={i} className={cn("flex items-start gap-3 px-3 py-2", ours && "bg-accent-subtle")}>
                    <span className="data w-8 shrink-0 pt-0.5 text-right text-muted">{organic ? t.pos : ""}</span>
                    <div className="min-w-0 flex-1">
                      {organic ? (
                        <>
                          <div className="truncate">{t.title ?? t.url}</div>
                          <a href={t.url ?? "#"} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted hover:underline">
                            {t.url}
                          </a>
                        </>
                      ) : (
                        <span className="text-muted">
                          {featureLabel(t.type)}
                          {t.domain && !t.domain.startsWith("google.") ? ` · ${t.domain}` : ""}
                        </span>
                      )}
                    </div>
                    {ours && <Badge tone="accent">you</Badge>}
                    {comp && (
                      <Badge title={comp} className="max-w-[45%] overflow-hidden">
                        {comp}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </Section>

      <Section title="Check history" description="What each check saw, including AI Overviews from the weekly check. A check marked not confirmed found no result on any look and repeats the last one seen.">
        <DataTable filename={`rank-${keyword.keyword.replace(/\W+/g, "-")}`} searchable={false} initialSort={{ key: "date", desc: true }} rows={checkRows} columns={withoutEmptyColumns(checkColumns, checkRows, ["seen", "features", "aio"])} />
      </Section>

      <Card className="mt-8 max-w-xl">
        <CardHeader title="Tags" />
        <CardBody>
          <ActionForm action={setKeywordTags.bind(null, project.id, id)} className="flex gap-2">
            <Input name="tags" aria-label="Tags for this keyword, separated by commas" defaultValue={keyword.tags.join(", ")} placeholder="core, brand" />
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}
