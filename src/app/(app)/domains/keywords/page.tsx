import Link from "next/link";
import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { PlanFeature } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { locationName } from "@/lib/dataforseo/locations";
import { formatNumber } from "@/lib/format";
import { keywordsFigures, keywordsSentence, type ViewCounts } from "@/modules/domains/brief";
import { DomainBriefing, DomainSource } from "@/modules/domains/components/brief-view";
import { DomainEmpty } from "@/modules/domains/components/domain-empty";
import { ViewLinks } from "@/modules/domains/components/view-links";
import { domainContext, domainTabs, holdToQuote, lookupOf, type DomainContext } from "@/modules/domains/context";
import { KEYWORD_LIMITS, parseLimit, priceQuote, rankedKeywordsSpec } from "@/modules/domains/requests";
import { filterView, RANK_VIEWS, rankedRows, withData, type RankView } from "@/modules/domains/transform";
import type { RankedKeywordsResult } from "@/modules/domains/types";
import { KeywordGrid, type GridColumn } from "@/modules/keywords/components/keyword-grid";
import { ResearchForm, RunPrompt } from "@/modules/keywords/components/research-ui";
import { loadOnce, peek, settle } from "@/modules/keywords/dfs";
import { costLabel } from "@/modules/keywords/format";
import { listOptions } from "@/modules/keywords/lists";
import { href, param } from "@/modules/keywords/market";

export const metadata = { title: "Domain keywords" };

const COLUMNS: GridColumn[] = [
  { key: "keyword", label: "Keyword", format: "keyword" },
  { key: "intent", label: "Intent", format: "intent" },
  { key: "position", label: "Position", format: "position" },
  { key: "previous", label: "Previous rank", format: "position" },
  { key: "change", label: "Rank change", format: "change" },
  { key: "volume", label: "Volume", format: "number" },
  { key: "kd", label: "Difficulty", format: "kd" },
  { key: "cpc", label: "Cost per click", format: "usd" },
  { key: "traffic", label: "Traffic", format: "number" },
  { key: "share", label: "Share of traffic", format: "pct" },
  { key: "url", label: "URL", format: "url" },
];

type Base = Record<string, string | number | undefined>;

const loadKeywords = (c: DomainContext, limit: number) => loadOnce<RankedKeywordsResult>(rankedKeywordsSpec(c.q, c.m, limit), { run: c.run, workspaceId: c.workspaceId, projectId: c.project?.id });

export default async function DomainKeywordsPage({ searchParams }: PageProps<"/domains/keywords">) {
  const sp = await searchParams;
  let c = await domainContext(sp);
  const limit = parseLimit(param(sp.limit));
  const rawView = param(sp.view);
  const view: RankView = rawView && rawView in RANK_VIEWS ? (rawView as RankView) : "all";
  const url = param(sp.url);
  const spec = rankedKeywordsSpec(c.q || "x", c.m, limit);
  const cached = c.q ? !!(await peek(spec, c.workspaceId)) : false;
  const cost = cached ? 0 : spec.estUsd;
  c = holdToQuote(c, sp, cost, `,${limit}`);
  const left = c.run ? 0 : cost;
  const base = { q: c.q, loc: c.m.locationCode, limit: limit === 500 ? undefined : limit, url };
  const location = locationName(c.m.locationCode);
  const form = <ResearchForm action="/domains/keywords" q={c.q || c.invalid || ""} placeholder="Domain, e.g. example.com" locationCode={c.m.locationCode} costUsd={left} freshUsd={spec.estUsd} ceiling hidden={{ limit: String(limit), quoted: priceQuote(lookupOf(c, `,${limit}`), left) }} refused={c.refused} />;

  return (
    <>
      <PageHeader
        title="Domain analysis"
        description={c.q ? <DomainSource text={`Keywords ${c.q} ranks for on Google in ${location}, with estimated traffic.`} loads={() => [loadKeywords(c, limit)]} /> : `Keywords a domain ranks for on Google in ${location}, with estimated traffic.`}
        actions={c.q && !c.free ? form : undefined}
      />
      <ModuleTabs tabs={domainTabs(c.q, c.m.locationCode)} />
      {/* Free has no research credits: it's told what Starter adds instead of offered a lookup it would refuse. */}
      {c.free && (!c.q || cost > 0) ? (
        <PlanFeature module="domains" />
      ) : !c.q ? (
        <DomainEmpty invalid={c.invalid} title="Pick a domain" description="Enter a domain to list the keywords it ranks for." action={form} />
      ) : (
        <>
          {url && (
            <div className="mb-5">
              <Callout title="Filtered to one page">
                {url} ·{" "}
                <Link href={href("/domains/keywords", { ...base, url: undefined, view })} className="text-accent hover:underline">
                  Show all pages
                </Link>
              </Callout>
            </div>
          )}
          {cost > 0 && !c.run ? (
            <div className="flex flex-col gap-4">
              <RunPrompt
                title={`Look up the keywords of ${c.q}`}
                description={`Top ${formatNumber(limit)} by traffic, including recently lost rankings. Saved for 7 days; you pay per row returned.`}
                href={href("/domains/keywords", { ...base, view, run: 1 })}
                costUsd={cost} ceiling refused={c.refused}
              />
              <Rows c={c} limit={limit} base={base} />
            </div>
          ) : (
            <Suspense fallback={<PageSkeleton header={false} />}>
              <Ranked c={c} limit={limit} view={view} url={url} base={base} />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}

/** How many rows to load. Choosing one doesn't spend: an unsaved size lands on the Run prompt. */
function Rows({ c, limit, base }: { c: DomainContext; limit: number; base: Base }) {
  return (
    <div className="flex max-w-full min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs text-muted">Rows</span>
      <ViewLinks
        label="Rows to load"
        options={KEYWORD_LIMITS.map((l) => ({
          href: href("/domains/keywords", { ...base, limit: l === 500 ? undefined : l }),
          label: `Top ${formatNumber(l)} (${costLabel(rankedKeywordsSpec(c.q, c.m, l).estUsd)} max)`,
          active: l === limit,
        }))}
      />
    </div>
  );
}

async function Ranked({ c, limit, view, url, base }: { c: DomainContext; limit: number; view: RankView; url: string | undefined; base: Base }) {
  const loaded = await settle(() => loadKeywords(c, limit));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const data = loaded.value;
  if (data.state === "idle") return null;
  const result = data.results[0];
  const all = rankedRows(result?.items).filter((r) => !url || r.url === url);
  const counts = Object.fromEntries((Object.keys(RANK_VIEWS) as RankView[]).map((v) => [v, filterView(all, v).length])) as ViewCounts;
  const rows = filterView(all, view);
  const lists = c.scope ? await listOptions(c.scope) : null;
  const viewHref = (v: RankView) => href("/domains/keywords", { ...base, view: v === "all" ? undefined : v });
  const columns = view === "lost" ? COLUMNS.filter((col) => !["position", "change", "traffic", "share"].includes(col.key)) : COLUMNS;

  return (
    <>
      <DomainBriefing
        sentence={keywordsSentence(c.q, counts, !!url)}
        figures={keywordsFigures({
          counts,
          traffic: all.reduce((n, r) => n + r.traffic, 0),
          loaded: result?.items?.length ?? 0,
          total: result?.total_count ?? 0,
          links: { up: viewHref("improved"), down: viewHref("declined") },
        })}
      />
      <Section
        title={`${RANK_VIEWS[view]} keywords`}
        description={`${formatNumber(counts.all)} ranking and ${formatNumber(counts.lost)} lost${url ? " on this page" : ""}. ${formatNumber(result?.items?.length ?? 0)} of ${formatNumber(result?.total_count ?? 0)} rows loaded.`}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ViewLinks label="Keywords to show" options={(Object.keys(RANK_VIEWS) as RankView[]).map((v) => ({ href: viewHref(v), label: `${RANK_VIEWS[v]} ${formatNumber(counts[v])}`, active: v === view }))} />
          {/* Its sizes carry prices, and on Free any size not saved yet lands on the plan note. */}
          {!c.free && <Rows c={c} limit={limit} base={base} />}
        </div>
        <KeywordGrid
          rows={rows}
          columns={withData(columns, rows, ["keyword"])}
          lists={lists}
          market={c.m}
          source={`domain:${c.q}`}
          filename={`${c.q}-keywords${view === "all" ? "" : `-${view}`}`}
          initialSort={{ key: view === "lost" ? "volume" : "traffic", desc: true }}
        />
        <p className="mt-3 max-w-[69ch] text-xs text-muted">
          Ranking and lost keywords together make up the rows loaded; New, Improved and Declined are part of Ranking. Position is the organic position. Previous rank and Rank change count everything on the results page (ads, snippets, map packs), because that&apos;s the only earlier rank available. Traffic is an estimate of monthly clicks.
        </p>
      </Section>
    </>
  );
}
