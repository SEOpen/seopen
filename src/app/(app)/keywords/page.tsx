import Link from "next/link";
import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { Trend } from "@/components/ui/trend";
import { isFree } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { countOf } from "@/lib/brief";
import { locationName } from "@/lib/dataforseo/locations";
import { adsAccepts, type Place } from "@/lib/dataforseo/place-names";
import { formatNumber } from "@/lib/format";
import { getCurrentProject, type Project } from "@/lib/projects";
import { wantsRun } from "@/lib/run-request";
import { projectScope } from "@/lib/workspace";
import { workspaceScope } from "@/lib/workspace/current";
import { newBriefHref } from "@/modules/content-briefs/href";
import { countryName, lookupFigures, lookupSentence } from "@/modules/keywords/brief";
import { researchCity } from "@/modules/keywords/city";
import { anyRefused, failuresToShow } from "@/modules/keywords/failures";
import { load, peek, pendingCost, settle } from "@/modules/keywords/dfs";
import { KeywordsPlanFeature } from "@/modules/keywords/components/plan-note";
import { FetchedNote, ResearchForm, RunPrompt, RunRest } from "@/modules/keywords/components/research-ui";
import { SaveKeyword } from "@/modules/keywords/components/save-keyword";
import { SerpTable } from "@/modules/keywords/components/serp-table";
import { intentTone, searchesIn } from "@/modules/keywords/format";
import { listOptions, listSummaries } from "@/modules/keywords/lists";
import { href, keywordQuery, keywordTabs, param, resolveMarket } from "@/modules/keywords/market";
import { RECENT_DAYS, recentLookups } from "@/modules/keywords/recent";
import { cityVolumeSpec, keywordLookupQuote, keywordOverviewSpec, MAX_KEYWORD_LENGTH, questionsSpec, serpSpec, suggestionsSpec, type Market } from "@/modules/keywords/requests";
import { featureLabel, serpRows, toKeywordRow, volumeTrend } from "@/modules/keywords/transform";
import type { KeywordOverviewResult, SerpResult, SuggestionsResult } from "@/modules/keywords/types";
import type { AdsVolumeResult } from "@/modules/rank/types";
import { rules } from "@/plan-policy/rules";

export const metadata = { title: "Keyword research" };

// No run=1 on the link: opening one spends nothing, and anything no longer kept asks first.
// The volumes are the country's, from Labs, even with a city picked, so the column says so.
const recentColumns = (country: string): ColumnSpec[] => [
  { key: "keyword", label: "Keyword", format: "link", href: "/keywords?q={keyword}&loc={loc}&city={city}" },
  { key: "volume", label: searchesIn(country), format: "number" },
  { key: "kd", label: "Difficulty", format: "number" },
  { key: "lookedUpAt", label: "Looked up", format: "date" },
];

export default async function KeywordsPage({ searchParams }: PageProps<"/keywords">) {
  const sp = await searchParams;
  const { q, tooLong } = keywordQuery(param(sp.q));
  const run = await wantsRun(sp.run);
  const project = await getCurrentProject();
  const m = resolveMarket(param(sp.loc), project);
  const { city, param: cityParam } = await researchCity(param(sp.city), m, project);
  const specsFor = (keyword: string) => [keywordOverviewSpec(keyword, m), serpSpec(keyword, m, city?.code), ...(city && adsAccepts(keyword) ? [cityVolumeSpec(keyword, m, city.code)] : [])];
  const fullCost = specsFor(q || "x").reduce((sum, s) => sum + s.estUsd, 0);
  const cost = q ? await pendingCost(specsFor(q), (await workspaceScope()).workspaceId) : fullCost;
  // Nothing to show yet means the page is for this one button; part of it showing means the button is secondary and asks.
  const nothingLoaded = cost >= fullCost;
  const saved = project && !q && !tooLong ? await listSummaries(projectScope(project)) : [];
  const savedKeywords = saved.reduce((n, l) => n + l.keywords, 0);
  const recent = !q && !tooLong ? await recentLookups((await workspaceScope()).workspaceId, m) : [];
  const { refusal, workspace } = await spendState((await workspaceScope()).workspaceId);
  const header = (
    <>
      <PageHeader title="Keyword research" description={`Search volume, difficulty and intent for one keyword, and the live top 10 on Google · ${city ? `${city.name} · ` : ""}${locationName(m.locationCode)}`} />
      <ModuleTabs tabs={keywordTabs(q, m.locationCode, cityParam)} />
    </>
  );
  // Free has no research credits, so it's told what Starter adds instead of offered a lookup it would refuse.
  if (isFree(workspace)) {
    return (
      <>
        {header}
        <KeywordsPlanFeature hasLists={saved.length > 0} locationCode={m.locationCode} />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="mb-5">
        <ResearchForm action="/keywords" q={q} placeholder="Enter a keyword" locationCode={m.locationCode} costUsd={cost} freshUsd={fullCost} quote={keywordLookupQuote(m)} withCity city={city} quiet={!!q} refused={refusal?.message} />
      </div>
      {tooLong ? (
        <EmptyState title="That keyword is too long" description={`Keywords can be up to ${formatNumber(MAX_KEYWORD_LENGTH)} characters, so nothing was looked up.`} />
      ) : !q && recent.length > 0 ? (
        <Section title={`Looked up in the last ${RECENT_DAYS} days`} description={`Opening one ${rules.hasPlans ? "uses no credits" : "costs nothing"}. Metrics are kept 30 days and the live top 10 for 24 hours, and anything no longer kept asks first.`}>
          <DataTable
            filename="recent-keywords"
            searchable={false}
            columns={recentColumns(countryName(locationName(m.locationCode)))}
            rows={recent.map((r) => ({ ...r, loc: m.locationCode, city: cityParam ?? 0 }))}
          />
        </Section>
      ) : !q ? (
        <EmptyState
          title="Look up a keyword"
          description={`Enter a keyword to see its volume, difficulty, intent, 12-month trend and who ranks in the top 10.${saved.length ? ` You have ${countOf(savedKeywords, "keyword")} saved in ${countOf(saved.length, "list")}.` : ""}`}
          action={
            saved.length > 0 ? (
              <ButtonLink href={href("/keywords/lists", { loc: m.locationCode })} variant="secondary">
                Open saved lists
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <>
          {cost > 0 && !run && nothingLoaded && (
            <RunPrompt
              title={`“${q}” isn't loaded yet`}
              description={
                city
                  ? `Metrics for ${locationName(m.locationCode)} and searches a month in ${city.name} (kept 30 days), and the live top 10 from ${city.name} (kept 24 hours).`
                  : "Keyword metrics (kept 30 days) and the live top 10 (kept 24 hours)."
              }
              // The city is pinned, 0 for none: left out, the same address would take on another project's city and spend again.
              href={href("/keywords", { q, loc: m.locationCode, city: cityParam ?? 0, run: 1 })}
              costUsd={cost}
              refused={refusal?.message}
            />
          )}
          {cost > 0 && !run && !nothingLoaded && (
            <div className="mb-5">
              <RunRest
                action="/keywords"
                params={{ q, loc: m.locationCode, city: cityParam ?? 0 }}
                description={`Part of “${q}” isn't loaded. Metrics are kept 30 days and the live top 10 for 24 hours.`}
                costUsd={cost}
                refused={refusal?.message}
              />
            </div>
          )}
          <Suspense fallback={<PageSkeleton header={false} label="Loading keyword" />}>
            <Results q={q} m={m} city={city} run={run} project={project} />
          </Suspense>
          <Suspense fallback={null}>
            <IdeaPreviews q={q} m={m} />
          </Suspense>
        </>
      )}
    </>
  );
}

/**
 * Everything one lookup shows. The three loads run side by side and each settles alone, so one failing
 * leaves the others on the page. They spend only under `run`, once each.
 */
async function Results({ q, m, city, run, project }: { q: string; m: Market; city: Place | null; run: boolean; project: Project | null }) {
  const { workspaceId } = await workspaceScope();
  const opts = { run, workspaceId, projectId: project?.id };
  const asked = !!city && adsAccepts(q);
  const [overview, serp, cityVolume] = await Promise.all([
    settle(() => load<KeywordOverviewResult>(keywordOverviewSpec(q, m), opts)),
    settle(() => load<SerpResult>(serpSpec(q, m, city?.code), opts)),
    asked ? settle(() => load<AdsVolumeResult>(cityVolumeSpec(q, m, city.code), opts)) : null,
  ]);
  const country = countryName(locationName(m.locationCode));
  const loads = [cityVolume, overview, serp];
  const shown = failuresToShow(loads, anyRefused(loads) ? (await spendState(workspaceId)).refusal?.code : null);

  // The city's own number, once it's something to say: null while it isn't loaded.
  const cityBrief = !city
    ? null
    : !asked
      ? { name: city.name, volume: null, reportable: false }
      : cityVolume?.ok && cityVolume.value.state === "ready"
        ? { name: city.name, volume: cityVolume.value.results[0]?.search_volume ?? null, reportable: true }
        : null;

  const overviewData = overview.ok && overview.value.state === "ready" ? overview.value : null;
  const item = overviewData?.results[0]?.items?.[0] ?? null;
  const row = item ? toKeywordRow(item) : null;
  const serpData = serp.ok && serp.value.state === "ready" ? serp.value : null;
  const serpResult = serpData?.results[0] ?? null;
  const rows = serpRows(serpResult, project?.domain);
  const features = (serpResult?.item_types ?? []).filter((t) => t !== "organic");
  const mine = rows.find((r) => r.isProject && r.type === "organic");
  const own = project && serpData ? { domain: project.domain, position: mine?.position ?? null } : null;
  const lists = project && row ? await listOptions(projectScope(project)) : null;

  const trend = volumeTrend(item?.keyword_info?.monthly_searches);
  const newest = trend.at(-1);
  const latest = newest?.value != null ? { month: newest.date.slice(0, 7), volume: newest.value } : null;
  const brief = item && row ? { keyword: q, place: country, volume: row.volume, yearly: item.keyword_info?.search_volume_trend?.yearly ?? null, latest, kd: row.kd, cpc: row.cpc, competition: row.competition, competitionLevel: item.keyword_info?.competition_level ?? null, city: cityBrief, own } : null;

  return (
    <>
      {cityVolume && !cityVolume.ok && shown.has(cityVolume.error) && (
        <div className="mb-4">
          <ApiError error={cityVolume.error} />
        </div>
      )}
      {!overview.ok && shown.has(overview.error) && (
        <div className="mb-4">
          <ApiError error={overview.error} />
        </div>
      )}
      {/* The Briefing carries the city's number. With no Briefing, for metrics that failed or came back empty, it still gets said. */}
      {!brief && cityBrief && (
        <div className="mb-4">
          <CityNotice city={cityBrief} country={country} />
        </div>
      )}
      {overviewData && !item && <EmptyState title="No data for this keyword" description="There's no search volume on record for it in this market." />}

      {brief && row && (
        <>
          <Briefing sentence={lookupSentence(brief)}>
            {lookupFigures(brief).map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {row.intent && (
                <span className="inline-flex items-center gap-1.5">
                  Search intent
                  <Badge tone={intentTone(row.intent)} className="capitalize">
                    {row.intent}
                  </Badge>
                </span>
              )}
              <span>
                {row.words} word{row.words === 1 ? "" : "s"}
              </span>
              {city && (
                <span>
                  Only the top 10 is from {city.name}. The other numbers are for all of {country}.
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* A brief is measured in the project's market, so it's offered only when this lookup is in it. */}
              {project && m.locationCode === project.locationCode && (
                <ButtonLink href={newBriefHref(q, { from: "keywords" })} prefetch={false} variant="secondary" size="sm">
                  Create brief
                </ButtonLink>
              )}
              {lists && <SaveKeyword row={row} lists={lists} market={m} />}
            </div>
          </div>
        </>
      )}

      {!serp.ok && shown.has(serp.error) && (
        <div className="mt-4">
          <ApiError error={serp.error} />
        </div>
      )}
      {serpData && (
        <Section
          title="Top 10 on Google"
          description={
            <>
              {city ? `From ${city.name} · ` : ""}Desktop · {formatNumber(serpResult?.se_results_count)} results · <FetchedNote fetchedAt={serpData.fetchedAt} cached={serpData.cached} />
            </>
          }
          // The figures say this once they're on the page; without them it still gets said.
          actions={own && !brief ? <span className="text-xs text-muted">{own.position == null ? `${own.domain} isn't in the top 10` : `${own.domain}: #${own.position}`}</span> : undefined}
        >
          {features.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Also on this results page:</span>
              {features.map((f) => (
                <Badge key={f}>{featureLabel(f)}</Badge>
              ))}
            </div>
          )}
          <SerpTable rows={rows} filename={`top-10-${q.replace(/\s+/g, "-")}`} />
        </Section>
      )}

      {overviewData && item && (
        <Section
          title="Search volume, last 12 months"
          description={
            <>
              All of {country} · <FetchedNote fetchedAt={overviewData.fetchedAt} cached={overviewData.cached} />
            </>
          }
        >
          <Trend points={trend} label="Searches a month" noun="month" monthly height={200} empty={<p className="text-sm text-secondary">No monthly data for this keyword.</p>} />
        </Section>
      )}
    </>
  );
}

/** The city's number when there's nothing else to put it beside. */
function CityNotice({ city, country }: { city: { name: string; volume: number | null; reportable: boolean }; country: string }) {
  const note = `Only the top 10 is from ${city.name}. The other numbers are for all of ${country}.`;
  if (!city.reportable) return <Callout title={`Google Ads can't report on this phrase for ${city.name}`}>{note}</Callout>;
  return <Callout title={city.volume == null ? `Too few searches in ${city.name} for Google to report a number` : `${formatNumber(city.volume)} searches a month in ${city.name}`}>{note}</Callout>;
}

/** Free previews: only shown when the idea lists are already cached. */
async function IdeaPreviews({ q, m }: { q: string; m: Market }) {
  const { workspaceId } = await workspaceScope();
  const [questions, suggestions] = await Promise.all([
    peek<SuggestionsResult>(questionsSpec(q, m), workspaceId),
    peek<SuggestionsResult>(suggestionsSpec(q, m), workspaceId),
  ]);
  const panels = [
    { title: "Questions", mode: "questions", hit: questions },
    { title: "Suggestions", mode: "suggestions", hit: suggestions },
  ];
  const link = "text-accent underline-offset-3 hover:underline";
  if (!questions && !suggestions) {
    return (
      <p className="mt-8 text-sm text-secondary">
        Questions and suggestions for this keyword aren&apos;t loaded yet. Open{" "}
        <Link href={href("/keywords/ideas", { q, loc: m.locationCode, mode: "questions" })} className={link}>
          Questions
        </Link>{" "}
        or{" "}
        <Link href={href("/keywords/ideas", { q, loc: m.locationCode, mode: "suggestions" })} className={link}>
          Suggestions
        </Link>{" "}
        to load them.
      </p>
    );
  }
  return (
    <div className="mt-8 grid items-start gap-6 @2xl/main:grid-cols-2">
      {panels.map((p) => {
        const items = p.hit?.res.tasks[0]?.result?.[0]?.items ?? [];
        return (
          <Section
            key={p.mode}
            className="mt-0"
            title={p.title}
            description={p.hit ? `${formatNumber(p.hit.res.tasks[0]?.result?.[0]?.total_count)} found` : "Not loaded yet"}
            actions={
              <Link href={href("/keywords/ideas", { q, loc: m.locationCode, mode: p.mode })} className={`text-xs ${link}`}>
                View all
              </Link>
            }
          >
            <ul className="divide-y divide-line-soft border-y border-line-soft text-sm">
              {items
                .filter((i) => i.keyword !== q)
                .slice(0, 8)
                .map((i) => (
                  <li key={i.keyword} className="flex justify-between gap-3 py-2">
                    <Link href={href("/keywords", { q: i.keyword, loc: m.locationCode })} className="min-w-0 truncate underline-offset-3 hover:underline">
                      {i.keyword}
                    </Link>
                    <span className="data text-muted">{formatNumber(i.keyword_info?.search_volume)}</span>
                  </li>
                ))}
              {!items.length && <li className="py-3 text-xs text-muted">Open Ideas to load this list.</li>}
            </ul>
          </Section>
        );
      })}
    </div>
  );
}
