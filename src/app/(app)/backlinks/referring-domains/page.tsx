import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { DataTable } from "@/components/ui/data-table";
import { FigureView } from "@/components/ui/figure";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { formatNumber } from "@/lib/format";
import { currentTimeZone } from "@/lib/workspace/current";
import { getReferringDomains, LIST_LIMIT, type DomainStatus } from "@/modules/backlinks/api";
import { domainsFigures, domainsSentence, freshnessOf, type DomainFacts } from "@/modules/backlinks/brief";
import { BacklinksHeader, BacklinksInvalid, CostNote, FilterPills, onFreePlan, param, resolveTarget, RunNeeded, wantsRun } from "@/modules/backlinks/header";
import { columnsWithData, isWithinDays, stripWww } from "@/modules/backlinks/logic";

export const metadata = { title: "Referring domains" };

const lead = (target: string) => `Domains linking to ${target}, strongest first.`;

export default async function ReferringDomainsPage({ searchParams }: PageProps<"/backlinks/referring-domains">) {
  const sp = await searchParams;
  const { target, invalid, project, isProjectDomain, workspaceId } = await resolveTarget(sp.q);
  if (invalid) return <BacklinksInvalid invalid={invalid} />;
  if (!target) return <NoProject />;
  const status: DomainStatus = param(sp.status) === "lost" ? "lost" : "live";

  return (
    <Suspense
      fallback={
        <>
          <BacklinksHeader description={lead(target)} target={target} loading />
          <PageSkeleton header={false} label="Loading referring domains" />
        </>
      }
    >
      <Domains target={target} status={status} workspaceId={workspaceId} projectId={isProjectDomain ? project!.id : null} run={!(await onFreePlan()) && (await wantsRun(sp.run))} />
    </Suspense>
  );
}

async function Domains({ target, status, workspaceId, projectId, run }: { target: string; status: DomainStatus; workspaceId: number; projectId: number | null; run: boolean }) {
  let res;
  try {
    res = await getReferringDomains(target, { status, workspaceId, projectId, run });
  } catch (e) {
    return (
      <>
        <BacklinksHeader description={lead(target)} target={target} />
        <ApiError error={e} />
      </>
    );
  }
  const filterParams = { q: target, status: status === "live" ? undefined : status };
  const pills = (
    <FilterPills
      basePath="/backlinks/referring-domains"
      params={filterParams}
      name="status"
      label="Domain status"
      options={[
        { value: "live", label: "Live" },
        { value: "lost", label: "Lost" },
      ]}
    />
  );
  if ("pending" in res) {
    return (
      <>
        <BacklinksHeader description={`${lead(target)} Not loaded yet.`} target={target} />
        <div className="flex flex-col gap-3">
          <div>{pills}</div>
          <RunNeeded what={`${status === "lost" ? "Lost" : "Live"} referring domains`} target={target} costUsd={res.estimateUsd} basePath="/backlinks/referring-domains" params={filterParams} ttl="7 days" />
        </div>
      </>
    );
  }
  const rows = res.data.items.map((d) => {
    const countries = Object.entries(d.referring_links_countries ?? {}).filter(([c]) => c && c !== "WW");
    return {
      domain: stripWww(d.domain),
      rank: d.rank,
      backlinks: d.backlinks,
      dofollow: (d.referring_domains_nofollow ?? 0) > 0 ? "nofollow" : "dofollow",
      spamScore: d.backlinks_spam_score,
      tld: d.domain.split(".").pop(),
      country: countries.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      firstSeen: d.first_seen,
      lostDate: d.lost_date,
      isNew: isWithinDays(d.first_seen, 30) ? "new" : null,
    };
  });
  const facts: DomainFacts[] = rows.map((r) => ({ firstSeen: r.firstSeen, lostDate: r.lostDate, nofollow: r.dofollow === "nofollow", spamScore: r.spamScore }));
  const timeZone = await currentTimeZone();

  return (
    <>
      <BacklinksHeader description={`${lead(target)} ${freshnessOf([res.meta], timeZone)}`} target={target} />
      <Briefing sentence={domainsSentence(status, res.data.total, facts)}>
        {domainsFigures(status, res.data.total, facts, `/backlinks/toxic?q=${encodeURIComponent(target)}`).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      <div className="mt-6">
        <DataTable
          filename={`referring-domains-${target}`}
          rows={rows}
          initialSort={{ key: "rank", desc: true }}
          toolbar={pills}
          columns={columnsWithData(
            [
              { key: "domain", label: "Domain", format: "link", href: "/backlinks?q={domain}" },
              { key: "isNew", label: "Status", format: "badge", sortable: false },
              { key: "rank", label: "Link strength", format: "number" },
              { key: "backlinks", label: "Backlinks", format: "number" },
              { key: "dofollow", label: "Follow", format: "badge" },
              { key: "spamScore", label: "Spam score", format: "number" },
              { key: "tld", label: "Domain ending" },
              { key: "country", label: "Country" },
              { key: "firstSeen", label: "First seen", format: "date" },
              ...(status === "lost" ? [{ key: "lostDate", label: "Lost", format: "date" as const }] : []),
            ],
            rows,
          )}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Showing {formatNumber(rows.length)} of {formatNumber(res.data.total)} {status} domains (top {LIST_LIMIT} by link strength: a score out of 1,000 for this domain&apos;s links to the target). &ldquo;new&rdquo; means first seen in the last 30 days.
      </p>
      <CostNote metas={[res.meta]} ttl="7 days" />
    </>
  );
}
