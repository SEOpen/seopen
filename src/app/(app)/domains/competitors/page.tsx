import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { PlanFeature } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { locationName } from "@/lib/dataforseo/locations";
import { formatNumber } from "@/lib/format";
import { listCompetitors } from "@/lib/projects";
import { competitorsFigures, competitorsSentence } from "@/modules/domains/brief";
import { DomainBriefing, DomainSource } from "@/modules/domains/components/brief-view";
import { CompetitorsTable } from "@/modules/domains/components/competitors-table";
import { DomainEmpty } from "@/modules/domains/components/domain-empty";
import { domainContext, domainTabs, holdToQuote, lookupOf, type DomainContext } from "@/modules/domains/context";
import { COMPETITORS_LIMIT, competitorsSpec, priceQuote, rankOverviewSpec } from "@/modules/domains/requests";
import { competitorRows } from "@/modules/domains/transform";
import type { CompetitorsResult, RankOverviewResult } from "@/modules/domains/types";
import { ResearchForm, RunPrompt } from "@/modules/keywords/components/research-ui";
import { loadOnce, peek, settle } from "@/modules/keywords/dfs";
import { href } from "@/modules/keywords/market";

export const metadata = { title: "Organic competitors" };

const loadCompetitors = (c: DomainContext) => loadOnce<CompetitorsResult>(competitorsSpec(c.q, c.m), { run: c.run, workspaceId: c.workspaceId, projectId: c.project?.id });

export default async function CompetitorsPage({ searchParams }: PageProps<"/domains/competitors">) {
  const sp = await searchParams;
  let c = await domainContext(sp);
  const spec = competitorsSpec(c.q || "x", c.m);
  const cost = c.q && (await peek(spec, c.workspaceId)) ? 0 : spec.estUsd;
  c = holdToQuote(c, sp, cost);
  const left = c.run ? 0 : cost;
  const location = locationName(c.m.locationCode);
  const form = <ResearchForm action="/domains/competitors" q={c.q || c.invalid || ""} placeholder="Domain, e.g. example.com" locationCode={c.m.locationCode} costUsd={left} freshUsd={spec.estUsd} ceiling hidden={{ quoted: priceQuote(lookupOf(c), left) }} refused={c.refused} />;

  return (
    <>
      <PageHeader
        title="Domain analysis"
        description={c.q ? <DomainSource text={`Domains that compete with ${c.q} for the same Google keywords in ${location}.`} loads={() => [loadCompetitors(c)]} /> : `Domains that compete with a domain for the same Google keywords in ${location}.`}
        actions={c.q && !c.free ? form : undefined}
      />
      <ModuleTabs tabs={domainTabs(c.q, c.m.locationCode)} />
      {/* Free has no research credits: it's told what Starter adds instead of offered a lookup it would refuse. */}
      {c.free && (!c.q || cost > 0) ? (
        <PlanFeature module="domains" />
      ) : !c.q ? (
        <DomainEmpty invalid={c.invalid} title="Pick a domain" description="Enter a domain to find its organic competitors." action={form} />
      ) : cost > 0 && !c.run ? (
        <RunPrompt
          title={`Look up the competitors of ${c.q}`}
          description={`Top ${COMPETITORS_LIMIT} by common keywords (very large sites excluded), saved for 7 days.`}
          href={href("/domains/competitors", { q: c.q, loc: c.m.locationCode, run: 1 })}
          costUsd={cost} ceiling refused={c.refused}
        />
      ) : (
        <Suspense fallback={<PageSkeleton header={false} />}>
          <Competitors c={c} />
        </Suspense>
      )}
    </>
  );
}

async function Competitors({ c }: { c: DomainContext }) {
  const loaded = await settle(() => Promise.all([
      loadCompetitors(c),
      peek<RankOverviewResult>(rankOverviewSpec(c.q, c.m), c.workspaceId),
      c.scope ? listCompetitors(c.scope) : Promise.resolve([]),
    ]));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const [data, overview, projectCompetitors] = loaded.value;
  if (data.state === "idle") return null;
  const own = overview?.res.tasks[0]?.result?.[0]?.items?.[0]?.metrics.organic?.count ?? null;
  const rows = competitorRows(data.results[0]?.items, c.q, own);
  const total = data.results[0]?.total_count ?? 0;
  return (
    <>
      <DomainBriefing sentence={competitorsSentence(c.q, rows)} figures={competitorsFigures(rows, total, href("/domains", { q: c.q, loc: c.m.locationCode }))} />
      <Section title="Organic competitors" description={`${formatNumber(rows.length)} of ${formatNumber(total)} competitors. Overlap is the share of ${c.q}'s keywords the competitor also ranks for.`}>
        <CompetitorsTable
          rows={rows}
          target={c.q}
          loc={c.m.locationCode}
          project={c.project ? { id: c.project.id, domain: c.project.domain, competitors: projectCompetitors } : null}
        />
      </Section>
    </>
  );
}
