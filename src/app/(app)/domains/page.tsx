import Link from "next/link";
import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PlanFeature } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { Trend } from "@/components/ui/trend";
import { locationName } from "@/lib/dataforseo/locations";
import { formatNumber, formatPct } from "@/lib/format";
import { CHANGES_NOTE, domainFigures, domainSentence } from "@/modules/domains/brief";
import { DomainBriefing, DomainSource, LookedUpNote } from "@/modules/domains/components/brief-view";
import { DomainEmpty } from "@/modules/domains/components/domain-empty";
import { MiniTable } from "@/modules/domains/components/mini-table";
import { PositionBars } from "@/modules/domains/components/position-bars";
import { domainContext, domainTabs, holdToQuote, lookupOf, type DomainContext } from "@/modules/domains/context";
import { competitorsSpec, historySpec, pagesSpec, priceQuote, rankedKeywordsSpec, rankOverviewSpec } from "@/modules/domains/requests";
import { recordSnapshot } from "@/modules/domains/snapshot";
import { competitorRows, distribution, historySeries, kpis, pageRows, rankedRows } from "@/modules/domains/transform";
import type { CompetitorsResult, HistoryResult, PagesResult, RankedKeywordsResult, RankOverviewResult } from "@/modules/domains/types";
import { CountryDataNote, NotLoaded, ResearchForm, RunPrompt, RunRest } from "@/modules/keywords/components/research-ui";
import { loadOnce, pendingCost, settle } from "@/modules/keywords/dfs";
import { INTENT_SHORT, intentTone } from "@/modules/keywords/format";
import { href } from "@/modules/keywords/market";

export const metadata = { title: "Domain analysis" };

function specs(c: DomainContext) {
  return {
    overview: rankOverviewSpec(c.q, c.m),
    history: historySpec(c.q, c.m),
    keywords: rankedKeywordsSpec(c.q, c.m),
    pages: pagesSpec(c.q, c.m),
    competitors: competitorsSpec(c.q, c.m),
  };
}

const opts = (c: DomainContext) => ({ run: c.run, workspaceId: c.workspaceId, projectId: c.project?.id });
const Skeleton = ({ h }: { h: string }) => <div className={`${h} mt-8 rounded-lg bg-surface-2`} />;

export default async function DomainsPage({ searchParams }: PageProps<"/domains">) {
  const sp = await searchParams;
  let c = await domainContext(sp);
  const s = c.q ? specs(c) : null;
  const all = s ? Object.values(s) : [];
  const fullCost = (s ? all : Object.values(specs({ ...c, q: "x" }))).reduce((n, x) => n + x.estUsd, 0);
  const cost = s ? await pendingCost(all, c.workspaceId) : fullCost;
  c = holdToQuote(c, sp, cost);
  // `cost` was read before this render's run spends it: once it's been paid, the form's button mustn't still show it.
  const left = c.run ? 0 : cost;
  const quoted = priceQuote(lookupOf(c), left);
  const location = locationName(c.m.locationCode);
  const waiting = cost > 0 && !c.run;
  // Nothing saved for this domain and nothing asked for: the page is the form and the lookup, with no empty sections.
  const untouched = waiting && cost === fullCost;
  // With a domain in hand, the page leads on its report or its Run, so looking up another one is secondary.
  const form = <ResearchForm action="/domains" q={c.q || c.invalid || ""} placeholder="Domain, e.g. example.com" locationCode={c.m.locationCode} costUsd={left} freshUsd={fullCost} ceiling hidden={{ quoted }} quiet={!!s} refused={c.refused} />;
  const saved = "You pay per row returned, so a lookup can cost less than this, never more. The numbers, top keywords, pages and competitors stay saved for 7 days, so reopening them is free. The 2-year history costs 10 times the normal rate, and stays saved for up to 30 days: it updates when a new month starts.";
  const note = <CountryDataNote project={c.project} locationCode={c.m.locationCode} what="Domain analysis measures" />;

  return (
    <>
      <PageHeader
        title="Domain analysis"
        description={
          s ? (
            <DomainSource text={`Estimated Google rankings and traffic for ${c.q} in ${location}.`} loads={() => [loadOnce<RankOverviewResult>(s.overview, opts(c))]} />
          ) : (
            `Estimated Google keywords, traffic, top pages and competitors for any domain, in ${location}.`
          )
        }
        actions={s && !c.free ? form : undefined}
      />
      <ModuleTabs tabs={domainTabs(c.q, c.m.locationCode)} />
      {c.free && (!s || untouched) ? (
        <PlanFeature module="domains" />
      ) : !s ? (
        <>
          {note}
          <DomainEmpty invalid={c.invalid} title="Analyze a domain" description="Enter any domain to see its estimated organic traffic, ranking keywords, top pages and competitors." action={form} />
        </>
      ) : (
        <>
          {untouched && (
            <>
              {note}
              <RunPrompt title={`Look up ${c.q}`} description={saved} href={href("/domains", { q: c.q, loc: c.m.locationCode, run: 1 })} costUsd={cost} ceiling refused={c.refused} />
            </>
          )}
          {!untouched && (
            <>
              <Suspense fallback={<Skeleton h="h-40" />}>
                <OverviewBriefing c={c} />
              </Suspense>
              <div className="mt-4">
                {note}
                {waiting && !c.free && <RunRest action="/domains" params={{ q: c.q, loc: c.m.locationCode, quoted }} description={saved} costUsd={cost} ceiling refused={c.refused} />}
              </div>
              <div className="grid gap-x-8 @5xl/main:grid-cols-2">
                <Suspense fallback={<Skeleton h="h-80" />}>
                  <TopKeywords c={c} />
                </Suspense>
                <Suspense fallback={<Skeleton h="h-80" />}>
                  <TopPages c={c} />
                </Suspense>
              </div>
              <Suspense fallback={<Skeleton h="h-72" />}>
                <HistorySection c={c} />
              </Suspense>
              <Suspense fallback={<Skeleton h="h-48" />}>
                <Distribution c={c} />
              </Suspense>
              <Suspense fallback={<Skeleton h="h-60" />}>
                <TopCompetitors c={c} />
              </Suspense>
            </>
          )}
          {c.isProject && (
            <Suspense fallback={null}>
              <RecordSnapshot c={c} />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}

/** Two settles, so a failed history still leaves the numbers: its own section shows that error. */
async function OverviewBriefing({ c }: { c: DomainContext }) {
  const loaded = await settle(() => loadOnce<RankOverviewResult>(specs(c).overview, opts(c)));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const data = loaded.value;
  if (data.state === "idle") return null;
  const organic = data.results[0]?.items?.[0]?.metrics.organic;
  if (!organic) return <EmptyState title="No organic data" description={`No Google rankings found for ${c.q} in ${locationName(c.m.locationCode)}. Check the spelling, or try another market.`} />;
  const history = await settle(() => loadOnce<HistoryResult>(specs(c).history, opts(c)));
  // Not loaded or failed isn't the same as none: the briefing mustn't claim there are no earlier months.
  const points = history.ok && history.value.state === "ready" ? historySeries(history.value.results[0]?.items) : null;
  const readAt = data.fetchedAt ?? new Date();
  return <DomainBriefing sentence={domainSentence(c.q, organic, points, readAt)} figures={domainFigures(organic, points, readAt)} />;
}

async function Distribution({ c }: { c: DomainContext }) {
  const loaded = await settle(() => loadOnce<RankOverviewResult>(specs(c).overview, opts(c)));
  // OverviewBriefing shows a failure or an empty result.
  if (!loaded.ok || loaded.value.state === "idle") return null;
  const organic = loaded.value.results[0]?.items?.[0]?.metrics.organic;
  if (!organic || !kpis(organic)) return null;
  const changes = [
    { label: "New", value: organic.is_new },
    { label: "Improved", value: organic.is_up },
    { label: "Declined", value: organic.is_down },
    { label: "Lost", value: organic.is_lost },
  ];
  return (
    <Section title="Position distribution" description="Keywords by Google position. Positions 1 to 10 are page one.">
      <div className="grid gap-6 @2xl/main:grid-cols-[minmax(0,1fr)_16rem]">
        <PositionBars items={distribution(organic)} />
        <div>
          <h3 className="table-head mb-1">Since the last update</h3>
          <p className="mb-2 text-xs text-muted">{CHANGES_NOTE}</p>
          <ul className="flex flex-col">
            {changes.map((ch) => (
              <li key={ch.label} className="border-t border-line-soft">
                <Link href={href("/domains/keywords", { q: c.q, loc: c.m.locationCode, view: ch.label.toLowerCase() })} className="flex h-8 items-center justify-between gap-3 text-sm underline-offset-4 hover:underline">
                  {ch.label}
                  <span className="data">{formatNumber(ch.value)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

async function HistorySection({ c }: { c: DomainContext }) {
  const loaded = await settle(() => loadOnce<HistoryResult>(specs(c).history, opts(c)));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const data = loaded.value;
  const points = data.state === "ready" ? historySeries(data.results[0]?.items) : [];
  const line = (key: "traffic" | "keywords" | "top10") => points.map((p) => ({ date: `${p.date}-01`, value: p[key] }));
  return (
    <Section title="Traffic and keywords, last 2 years" description={data.state === "ready" ? <>Monthly estimates. <LookedUpNote loads={() => [loadOnce<HistoryResult>(specs(c).history, opts(c))]} /></> : "Monthly estimates"}>
      {data.state === "idle" ? (
        <NotLoaded costUsd={data.estUsd} ceiling />
      ) : points.length ? (
        <div className="grid gap-6 @3xl/main:grid-cols-3">
          <SmallChart title="Est. monthly traffic" points={line("traffic")} />
          <SmallChart title="Ranking keywords" points={line("keywords")} />
          <SmallChart title="Top 10 keywords" points={line("top10")} />
        </div>
      ) : (
        <p className="py-6 text-sm text-muted">No history for this domain.</p>
      )}
    </Section>
  );
}

function SmallChart({ title, points }: { title: string; points: { date: string; value: number }[] }) {
  return (
    <div className="min-w-0">
      <h3 className="table-head mb-1">{title}</h3>
      <Trend points={points} label={title} noun="month" monthly height={200} />
    </div>
  );
}

function ViewAll({ path, c, label = "View all" }: { path: string; c: DomainContext; label?: string }) {
  return (
    <Link href={href(path, { q: c.q, loc: c.m.locationCode })} className="text-xs text-accent hover:underline">
      {label}
    </Link>
  );
}

async function TopKeywords({ c }: { c: DomainContext }) {
  const loaded = await settle(() => loadOnce<RankedKeywordsResult>(specs(c).keywords, opts(c)));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const data = loaded.value;
  const rows =
    data.state === "ready"
      ? rankedRows(data.results[0]?.items)
          .filter((r) => r.status !== "lost")
          .sort((a, b) => b.traffic - a.traffic)
          .slice(0, 10)
      : [];
  return (
    <Section className="min-w-0" title="Top keywords" description="By estimated traffic" actions={<ViewAll path="/domains/keywords" c={c} />}>
      {data.state === "idle" ? (
        <NotLoaded costUsd={data.estUsd} ceiling />
      ) : (
        <MiniTable
          rows={rows}
          columns={[
            {
              label: "Keyword",
              className: "max-w-0 w-full",
              render: (r) => (
                <Link href={href("/keywords", { q: r.keyword, loc: c.m.locationCode })} className="block truncate">
                  {r.keyword}
                </Link>
              ),
            },
            { label: "Intent", isEmpty: (r) => !r.intent, render: (r) => (r.intent ? <Badge tone={intentTone(r.intent)} title={r.intent}>{INTENT_SHORT[r.intent] ?? r.intent}</Badge> : null) },
            { label: "Position", align: "right", render: (r) => r.position },
            { label: "Volume", align: "right", isEmpty: (r) => r.volume == null, render: (r) => formatNumber(r.volume) },
            { label: "Traffic", align: "right", render: (r) => formatNumber(Math.round(r.traffic)) },
          ]}
        />
      )}
    </Section>
  );
}

async function TopPages({ c }: { c: DomainContext }) {
  const loaded = await settle(() => loadOnce<PagesResult>(specs(c).pages, opts(c)));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const data = loaded.value;
  const rows = data.state === "ready" ? pageRows(data.results[0]?.items).slice(0, 10) : [];
  return (
    <Section className="min-w-0" title="Top pages" description="By estimated traffic" actions={<ViewAll path="/domains/pages" c={c} />}>
      {data.state === "idle" ? (
        <NotLoaded costUsd={data.estUsd} ceiling />
      ) : (
        <MiniTable
          rows={rows}
          columns={[
            {
              label: "Page",
              className: "max-w-0 w-full",
              render: (r) => (
                <a href={r.url} target="_blank" rel="noreferrer" className="data block truncate" title={r.url}>
                  {r.path}
                </a>
              ),
            },
            {
              label: "Keywords",
              align: "right",
              render: (r) => <Link href={href("/domains/keywords", { q: c.q, loc: c.m.locationCode, url: r.url })}>{formatNumber(r.keywords)}</Link>,
            },
            { label: "Traffic", align: "right", render: (r) => formatNumber(r.traffic) },
            { label: "Share", align: "right", render: (r) => formatPct(r.share, 0) },
          ]}
        />
      )}
    </Section>
  );
}

async function TopCompetitors({ c }: { c: DomainContext }) {
  const loaded = await settle(() => Promise.all([
      loadOnce<CompetitorsResult>(specs(c).competitors, opts(c)),
      loadOnce<RankOverviewResult>(specs(c).overview, opts(c)),
    ]));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const [data, overview] = loaded.value;
  const own = overview.state === "ready" ? (overview.results[0]?.items?.[0]?.metrics.organic?.count ?? null) : null;
  const rows = data.state === "ready" ? competitorRows(data.results[0]?.items, c.q, own).slice(0, 8) : [];
  return (
    <Section title="Organic competitors" description="Domains that rank for the same keywords" actions={<ViewAll path="/domains/competitors" c={c} />}>
      {data.state === "idle" ? (
        <NotLoaded costUsd={data.estUsd} ceiling />
      ) : (
        <MiniTable
          rows={rows}
          columns={[
            {
              label: "Domain",
              render: (r) => <Link href={href("/domains", { q: r.domain, loc: c.m.locationCode })}>{r.domain}</Link>,
            },
            {
              label: "Overlap",
              className: "w-1/3 min-w-32",
              isEmpty: (r) => !r.overlap,
              render: (r) => (
                <span className="flex items-center gap-2" title={`${formatPct(r.overlap, 0)} of ${c.q}'s keywords`}>
                  <span className="h-1.5 min-w-16 flex-1 rounded-sm bg-surface-2">
                    <span className="block h-full rounded-sm bg-secondary" style={{ width: `${r.overlap * 100}%` }} />
                  </span>
                  <span className="data w-9 text-right text-muted">{formatPct(r.overlap, 0)}</span>
                </span>
              ),
            },
            { label: "Common", align: "right", render: (r) => formatNumber(r.common) },
            { label: "Their keywords", align: "right", render: (r) => formatNumber(r.keywords) },
            { label: "Their traffic", align: "right", render: (r) => formatNumber(r.traffic) },
          ]}
        />
      )}
    </Section>
  );
}

/** Saves the project's snapshot when this render fetched fresh data. Renders nothing. */
async function RecordSnapshot({ c }: { c: DomainContext }) {
  try {
    const [overview, history] = await Promise.all([
      loadOnce<RankOverviewResult>(specs(c).overview, opts(c)),
      loadOnce<HistoryResult>(specs(c).history, opts(c)),
    ]);
    const organic = overview.state === "ready" ? overview.results[0]?.items?.[0]?.metrics.organic : null;
    const fresh = (overview.state === "ready" && !overview.cached) || (history.state === "ready" && !history.cached);
    if (organic && fresh && c.project) {
      await recordSnapshot(c.project, c.m, organic, history.state === "ready" ? historySeries(history.results[0]?.items) : null);
    }
  } catch {
    // The sections above already show API errors.
  }
  return null;
}
