import Link from "next/link";
import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { PlanFeature } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { LOCATIONS, locationName } from "@/lib/dataforseo/locations";
import { formatNumber } from "@/lib/format";
import { listCompetitors, normalizeDomain } from "@/lib/projects";
import { gapFigures, gapSentence } from "@/modules/domains/brief";
import { DomainBriefing, DomainSource } from "@/modules/domains/components/brief-view";
import { DomainEmpty } from "@/modules/domains/components/domain-empty";
import { ViewLinks } from "@/modules/domains/components/view-links";
import { domainContext, domainTabs, holdToQuote, lookupOf, type DomainContext } from "@/modules/domains/context";
import { KEYWORD_LIMITS, parseLimit, priceQuote, rankedKeywordsSpec } from "@/modules/domains/requests";
import { buildGap, gapCounts, GAP_TABS, isHostname, withData, type GapTab } from "@/modules/domains/transform";
import type { RankedKeywordsResult } from "@/modules/domains/types";
import { KeywordGrid, type GridColumn } from "@/modules/keywords/components/keyword-grid";
import { LookupButton } from "@/modules/keywords/components/lookup-button";
import { RunPrompt } from "@/modules/keywords/components/research-ui";
import { loadOnce, pendingCost, settle } from "@/modules/keywords/dfs";
import { costLabel, maxCostLabel } from "@/modules/keywords/format";
import { listOptions } from "@/modules/keywords/lists";
import type { LookupQuote } from "@/modules/keywords/lookup-quote";
import { href, param } from "@/modules/keywords/market";

export const metadata = { title: "Keyword gap" };

const MAX_OTHERS = 3;
/** You and one competitor: the fewest domains a comparison looks up. */
const MIN_DOMAINS = 2;

/** `vs` may be repeated (form inputs) or comma-separated (links). */
function parseVs(raw: string | string[] | undefined, you: string): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw ?? ""]).flatMap((s) => s.split(","));
  return [...new Set(parts.map((s) => normalizeDomain(s)).filter((d) => isHostname(d) && d !== you))].slice(0, MAX_OTHERS);
}

const loadAll = (c: DomainContext, domains: string[], limit: number) => domains.map((d) => loadOnce<RankedKeywordsResult>(rankedKeywordsSpec(d, c.m, limit), { run: c.run, workspaceId: c.workspaceId, projectId: c.project?.id }));

export default async function GapPage({ searchParams }: PageProps<"/domains/gap">) {
  const sp = await searchParams;
  let c = await domainContext(sp);
  const limit = parseLimit(param(sp.limit));
  const rawTab = param(sp.tab);
  const tab: GapTab = rawTab && rawTab in GAP_TABS ? (rawTab as GapTab) : "missing";
  let others = parseVs(sp.vs, c.q);
  if (!others.length && c.isProject && sp.vs === undefined) others = (await listCompetitors(c.scope!)).slice(0, MAX_OTHERS);
  const domains = c.q ? [c.q, ...others] : [];
  const specs = domains.map((d) => rankedKeywordsSpec(d, c.m, limit));
  const cost = await pendingCost(specs, c.workspaceId);
  const priced = `,${others.join(",")},${limit}`;
  c = holdToQuote(c, sp, cost, priced);
  const left = c.run ? 0 : cost;
  const quoted = priceQuote(lookupOf(c, priced), left);
  const perDomain = rankedKeywordsSpec("x", c.m, limit).estUsd;
  const base = { q: c.q, vs: others.join(","), loc: c.m.locationCode, limit: limit === 500 ? undefined : limit };
  const location = locationName(c.m.locationCode);
  const canCompare = !!c.q && others.length > 0;
  const showsResults = canCompare && !(cost > 0 && !c.run);
  // Before there are domains to price, the button says what the smallest comparison costs, then follows the form.
  const form = <GapForm c={c} others={others} limit={limit} cost={canCompare ? left : perDomain * MIN_DOMAINS} quoted={quoted} quiet={canCompare} />;

  return (
    <>
      <PageHeader
        title="Domain analysis"
        description={
          canCompare ? (
            <>
              <DomainSource text={`The Google keywords of ${c.q} against ${others.join(", ")} in ${location}.`} loads={() => loadAll(c, domains, limit)} />
              {showsResults && !c.free && (
                <>
                  {" "}
                  <a href="#compare" className="text-accent hover:underline">
                    Change the domains
                  </a>
                </>
              )}
            </>
          ) : (
            `Compare the Google keywords of up to four domains in ${location}.`
          )
        }
      />
      <ModuleTabs tabs={domainTabs(c.q, c.m.locationCode)} />
      {/* Free has no research credits: it's told what Starter adds instead of offered a lookup it would refuse. */}
      {c.free && !showsResults ? (
        <PlanFeature module="domains" />
      ) : !c.q ? (
        <DomainEmpty invalid={c.invalid} title="Pick domains to compare" description="Enter your domain and up to three competitors." action={form} />
      ) : !others.length ? (
        <EmptyState
          title="Add at least one competitor"
          description={
            <>
              Type competitor domains below, or find them on the{" "}
              <Link href={href("/domains/competitors", { q: c.q, loc: c.m.locationCode })} className="text-accent hover:underline">
                Competitors
              </Link>{" "}
              tab and add them to the project.
            </>
          }
          action={form}
        />
      ) : cost > 0 && !c.run ? (
        <div className="flex flex-col gap-4">
          <RunPrompt
            title={`Look up the ${domains.length} domains`}
            description={`Loads the top ${formatNumber(limit)} keywords by traffic for each domain that isn't saved yet (saved for 7 days). You pay per row returned.`}
            href={href("/domains/gap", { ...base, tab, run: 1, quoted })}
            costUsd={cost}
            ceiling
            refused={c.refused}
          />
          <Card>
            <CardBody>{form}</CardBody>
          </Card>
        </div>
      ) : (
        <>
          <Suspense fallback={<PageSkeleton header={false} />}>
            <Gap c={c} domains={domains} limit={limit} tab={tab} base={base} />
          </Suspense>
          {!c.free && (
            <Card id="compare" className="mt-8 scroll-mt-6">
              <CardHeader title="Change the comparison" description={`Other domains, another market, or more keywords per domain. At the top ${formatNumber(limit)} keywords, each domain not looked up yet costs ${costLabel(perDomain)}.`} />
              <CardBody>{form}</CardBody>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function GapForm({ c, others, limit, cost, quoted, quiet }: { c: DomainContext; others: string[]; limit: number; cost: number; quoted: string; quiet: boolean }) {
  // The price of any domain count at any limit. It's a ceiling: a domain already looked up at that limit is free.
  const prices = (l: number) => Array.from({ length: MAX_OTHERS + 2 }, (_, n) => maxCostLabel(rankedKeywordsSpec("x", c.m, l).estUsd * Math.max(n, MIN_DOMAINS)));
  const quote: LookupQuote = { kind: "keywordGap", byLimit: Object.fromEntries(KEYWORD_LIMITS.map((l) => [l, prices(l)])) };
  return (
    // Keyed on what it loaded: a link to another comparison keeps this page mounted, and the fields and price must start over.
    <form key={`${c.q}|${others.join()}|${c.m.locationCode}|${limit}`} action="/domains/gap" className="flex flex-wrap items-end gap-2">
      <Label>
        You
        <Input name="q" defaultValue={c.q || c.invalid || ""} placeholder="your-site.com" required className="w-48" />
      </Label>
      {Array.from({ length: MAX_OTHERS }, (_, i) => (
        <Label key={i}>
          Competitor {i + 1}
          <Input name="vs" defaultValue={others[i] ?? ""} placeholder="competitor.com" className="w-48" />
        </Label>
      ))}
      <Label>
        Market
        <Select name="loc" defaultValue={String(c.m.locationCode)}>
          {LOCATIONS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </Select>
      </Label>
      <Label>
        Keywords per domain
        <Select name="limit" defaultValue={String(limit)}>
          {KEYWORD_LIMITS.map((l) => (
            <option key={l} value={l}>
              Top {formatNumber(l)}
            </option>
          ))}
        </Select>
      </Label>
      <input type="hidden" name="quoted" value={quoted} />
      <input type="hidden" name="run" value="1" />
      <LookupButton label={maxCostLabel(cost)} quote={quote} quiet={quiet} refused={c.refused}>
        Compare
      </LookupButton>
    </form>
  );
}

async function Gap({
  c,
  domains,
  limit,
  tab,
  base,
}: {
  c: DomainContext;
  domains: string[];
  limit: number;
  tab: GapTab;
  base: Record<string, string | number | undefined>;
}) {
  const settled = await settle(() => Promise.all(loadAll(c, domains, limit)));
  if (!settled.ok) return <ApiError error={settled.error} />;
  const loaded = settled.value;
  if (loaded.some((l) => l.state === "idle")) return null;
  const results = loaded.map((l) => (l.state === "ready" ? l.results[0] : undefined));
  const gap = buildGap(results.map((r) => r?.items));
  const counts = gapCounts(gap);
  const rows = gap
    .filter((r) => r.tabs.includes(tab))
    .map(({ positions, ...r }) => ({ ...r, ...Object.fromEntries(positions.map((p, i) => [`p${i}`, p])) }));
  const truncated = domains.filter((_, i) => (results[i]?.total_count ?? 0) > (results[i]?.items?.length ?? 0));
  const lists = c.scope ? await listOptions(c.scope) : null;
  const tabLink = (t: GapTab) => href("/domains/gap", { ...base, tab: t });
  const positionColumns = domains.map<GridColumn>((d, i) => ({ key: `p${i}`, label: i === 0 ? `${d} (you)` : d, format: "position" }));
  const columns: GridColumn[] = [
    { key: "keyword", label: "Keyword", format: "keyword" },
    { key: "intent", label: "Intent", format: "intent" },
    ...positionColumns,
    { key: "volume", label: "Volume", format: "number" },
    { key: "kd", label: "Difficulty", format: "kd" },
    { key: "cpc", label: "Cost per click", format: "usd" },
  ];

  return (
    <>
      {truncated.length > 0 && (
        <div className="mb-5">
          <Callout tone="warn" title="Large domains are sampled">
            {truncated.join(", ")} rank for more than {formatNumber(limit)} keywords, so only their top {formatNumber(limit)} by traffic are compared. A keyword they rank for further down can show as missing.
          </Callout>
        </div>
      )}
      <DomainBriefing sentence={gapSentence(domains, counts)} figures={gapFigures(counts, tabLink)} />
      <Section
        title={`${GAP_TABS[tab].label} keywords`}
        description={`${GAP_TABS[tab].help}. Positions are each domain's best Google position; blank means not in its top ${formatNumber(limit)} keywords.`}
      >
        <div className="mb-3">
          <ViewLinks label="Keywords to show" options={(Object.keys(GAP_TABS) as GapTab[]).map((t) => ({ href: tabLink(t), label: `${GAP_TABS[t].label} ${formatNumber(counts[t])}`, active: t === tab }))} />
        </div>
        {/* A blank domain column is the answer on these tabs ("you don't rank"), so those stay. */}
        <KeywordGrid rows={rows} columns={withData(columns, rows, ["keyword", ...positionColumns.map((col) => col.key)])} lists={lists} market={c.m} source={`gap:${domains.join(",")}`} filename={`gap-${tab}-${c.q}`} initialSort={{ key: "volume", desc: true }} />
      </Section>
    </>
  );
}
