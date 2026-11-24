import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { PlanFeature } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { locationName } from "@/lib/dataforseo/locations";
import { formatNumber } from "@/lib/format";
import { pagesFigures, pagesSentence } from "@/modules/domains/brief";
import { DomainBriefing, DomainSource } from "@/modules/domains/components/brief-view";
import { DomainEmpty } from "@/modules/domains/components/domain-empty";
import { domainContext, domainTabs, holdToQuote, lookupOf, type DomainContext } from "@/modules/domains/context";
import { PAGES_LIMIT, pagesSpec, priceQuote } from "@/modules/domains/requests";
import { pageRows, sectionRows, withData } from "@/modules/domains/transform";
import type { PagesResult } from "@/modules/domains/types";
import { ResearchForm, RunPrompt } from "@/modules/keywords/components/research-ui";
import { loadOnce, peek, settle } from "@/modules/keywords/dfs";
import { href } from "@/modules/keywords/market";

export const metadata = { title: "Top pages" };

const COLUMNS: ColumnSpec[] = [
  { key: "url", label: "Page", format: "url" },
  { key: "keywords", label: "Keywords", format: "link", href: "/domains/keywords?q={domain}&loc={loc}&url={url}", align: "right" },
  { key: "top10", label: "Top 10", format: "number" },
  { key: "traffic", label: "Traffic", format: "number" },
  { key: "share", label: "Share of traffic", format: "pct" },
  { key: "trafficValue", label: "Traffic value", format: "usd" },
];

const SECTION_COLUMNS: ColumnSpec[] = [
  { key: "section", label: "Section" },
  { key: "pages", label: "Pages", format: "number" },
  { key: "keywords", label: "Keywords", format: "number" },
  { key: "traffic", label: "Traffic", format: "number" },
  { key: "share", label: "Share of traffic", format: "pct" },
  { key: "topPage", label: "Top page", format: "url" },
];

const loadPages = (c: DomainContext) => loadOnce<PagesResult>(pagesSpec(c.q, c.m), { run: c.run, workspaceId: c.workspaceId, projectId: c.project?.id });

export default async function PagesPage({ searchParams }: PageProps<"/domains/pages">) {
  const sp = await searchParams;
  let c = await domainContext(sp);
  const spec = pagesSpec(c.q || "x", c.m);
  const cost = c.q && (await peek(spec, c.workspaceId)) ? 0 : spec.estUsd;
  c = holdToQuote(c, sp, cost);
  const left = c.run ? 0 : cost;
  const location = locationName(c.m.locationCode);
  const form = <ResearchForm action="/domains/pages" q={c.q || c.invalid || ""} placeholder="Domain, e.g. example.com" locationCode={c.m.locationCode} costUsd={left} freshUsd={spec.estUsd} ceiling hidden={{ quoted: priceQuote(lookupOf(c), left) }} refused={c.refused} />;

  return (
    <>
      <PageHeader
        title="Domain analysis"
        description={c.q ? <DomainSource text={`The pages of ${c.q} that earn the most estimated Google traffic in ${location}.`} loads={() => [loadPages(c)]} /> : `The pages of a domain that earn the most estimated Google traffic in ${location}.`}
        actions={c.q && !c.free ? form : undefined}
      />
      <ModuleTabs tabs={domainTabs(c.q, c.m.locationCode)} />
      {/* Free has no research credits: it's told what Starter adds instead of offered a lookup it would refuse. */}
      {c.free && (!c.q || cost > 0) ? (
        <PlanFeature module="domains" />
      ) : !c.q ? (
        <DomainEmpty invalid={c.invalid} title="Pick a domain" description="Enter a domain to see its top pages." action={form} />
      ) : cost > 0 && !c.run ? (
        <RunPrompt title={`Look up the pages of ${c.q}`} description={`Top ${PAGES_LIMIT} pages by traffic, saved for 7 days.`} href={href("/domains/pages", { q: c.q, loc: c.m.locationCode, run: 1 })} costUsd={cost} ceiling refused={c.refused} />
      ) : (
        <Suspense fallback={<PageSkeleton header={false} />}>
          <Pages c={c} />
        </Suspense>
      )}
    </>
  );
}

async function Pages({ c }: { c: DomainContext }) {
  const loaded = await settle(() => loadPages(c));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  const data = loaded.value;
  if (data.state === "idle") return null;
  const rows = pageRows(data.results[0]?.items).map((r) => ({ ...r, domain: c.q, loc: c.m.locationCode }));
  const total = data.results[0]?.total_count ?? 0;
  // A traffic value of 0 in every row means the estimate is missing, not that the clicks are worthless.
  const sections = sectionRows(rows);
  const columns = withData(COLUMNS, rows).filter((col) => col.key !== "trafficValue" || rows.some((r) => r.trafficValue));
  return (
    <>
      <DomainBriefing sentence={pagesSentence(c.q, rows)} figures={pagesFigures(rows, total)} />
      {/* One section (a site that's all home page) says nothing a reader can't see in the table below. */}
      {sections.length > 1 && (
        <Section title="Sections" description={`The top ${formatNumber(rows.length)} pages added up by their first folder, which shows the kinds of page that earn the traffic. It covers these pages, not every page ${c.q} has.`}>
          <DataTable filename={`${c.q}-sections`} initialSort={{ key: "traffic", desc: true }} columns={SECTION_COLUMNS} rows={sections} />
        </Section>
      )}
      <Section
        title="Top pages"
        description={`${formatNumber(rows.length)} of ${formatNumber(total)} pages. Click a keyword count to see that page's keywords.${columns.some((col) => col.key === "trafficValue") && rows.some((r) => r.trafficValue == null) ? " A dash under Traffic value: no CPC data for that page's keywords." : ""}`}
      >
        <DataTable filename={`${c.q}-pages`} initialSort={{ key: "traffic", desc: true }} columns={columns} rows={rows} />
      </Section>
    </>
  );
}
