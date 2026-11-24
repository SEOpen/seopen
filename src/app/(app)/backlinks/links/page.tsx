import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { DataTable } from "@/components/ui/data-table";
import { FigureView } from "@/components/ui/figure";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { formatNumber } from "@/lib/format";
import { currentTimeZone } from "@/lib/workspace/current";
import { getBacklinks, LIST_LIMIT, type LinkStatus } from "@/modules/backlinks/api";
import { freshnessOf, linksFigures, linksSentence } from "@/modules/backlinks/brief";
import { BacklinksHeader, BacklinksInvalid, CostNote, FilterPills, onFreePlan, param, resolveTarget, RunNeeded, wantsRun } from "@/modules/backlinks/header";
import { columnsWithData, linkedPageRows } from "@/modules/backlinks/logic";

export const metadata = { title: "Backlinks list" };

const lead = (target: string) => `Individual links pointing to ${target}, strongest source first.`;
const pagesLead = (target: string) => `The pages of ${target} that the most other sites link to: what earns it its links.`;

export default async function LinksPage({ searchParams }: PageProps<"/backlinks/links">) {
  const sp = await searchParams;
  const { target, invalid, project, isProjectDomain, workspaceId } = await resolveTarget(sp.q);
  if (invalid) return <BacklinksInvalid invalid={invalid} />;
  if (!target) return <NoProject />;
  const s = param(sp.status);
  const status: LinkStatus = s === "new" || s === "lost" ? s : "live";
  const v = param(sp.view);
  const view = v === "domain" || v === "page" ? v : "all";
  const follow = param(sp.follow) === "dofollow" ? "dofollow" : "any";

  return (
    <Suspense
      fallback={
        <>
          <BacklinksHeader description={lead(target)} target={target} loading />
          <PageSkeleton header={false} label="Loading links" />
        </>
      }
    >
      <Links target={target} status={status} view={view} follow={follow} workspaceId={workspaceId} projectId={isProjectDomain ? project!.id : null} run={!(await onFreePlan()) && (await wantsRun(sp.run))} />
    </Suspense>
  );
}

async function Links({
  target,
  status,
  view,
  follow,
  workspaceId,
  projectId,
  run,
}: {
  target: string;
  status: LinkStatus;
  view: "all" | "domain" | "page";
  follow: "any" | "dofollow";
  workspaceId: number;
  projectId: number | null;
  run: boolean;
}) {
  let res;
  try {
    res = await getBacklinks(target, { status, onePerDomain: view !== "all", dofollowOnly: follow === "dofollow", workspaceId, projectId, run });
  } catch (e) {
    return (
      <>
        <BacklinksHeader description={lead(target)} target={target} />
        <ApiError error={e} />
      </>
    );
  }
  const params = {
    q: target,
    status: status === "live" ? undefined : status,
    view: view === "all" ? undefined : view,
    follow: follow === "any" ? undefined : follow,
  };
  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <FilterPills
        basePath="/backlinks/links"
        params={params}
        name="status"
        label="Link status"
        options={[
          { value: "live", label: "Live" },
          { value: "new", label: "New" },
          { value: "lost", label: "Lost" },
        ]}
      />
      <FilterPills
        basePath="/backlinks/links"
        params={params}
        name="view"
        label="Links per domain"
        options={[
          { value: "all", label: "All links" },
          { value: "domain", label: "One per domain" },
          { value: "page", label: "By page linked to" },
        ]}
      />
      <FilterPills
        basePath="/backlinks/links"
        params={params}
        name="follow"
        label="Followed links"
        options={[
          { value: "any", label: "Any" },
          { value: "dofollow", label: "Followed only" },
        ]}
      />
    </div>
  );
  if ("pending" in res) {
    return (
      <>
        <BacklinksHeader description={`${lead(target)} Not loaded yet.`} target={target} />
        <div className="flex flex-col gap-3">
          {toolbar}
          <RunNeeded what="This backlink list" target={target} costUsd={res.estimateUsd} basePath="/backlinks/links" params={params} ttl="7 days" />
        </div>
      </>
    );
  }
  const timeZone = await currentTimeZone();
  const header = <BacklinksHeader description={`${view === "page" ? pagesLead(target) : lead(target)} ${freshnessOf([res.meta], timeZone)}`} target={target} />;
  if (view === "page") {
    const pages = linkedPageRows(res.data.items).map((p) => ({
      url: p.url,
      referringDomains: p.referringDomains,
      dofollow: p.dofollow,
      topDomains: p.topDomains.map((d) => d.domain).join(", "),
      anchors: p.anchors.join(" · "),
    }));
    return (
      <>
        {header}
        <div className="mt-6">
          <DataTable
            filename={`linked-pages-${target}`}
            rows={pages}
            initialSort={{ key: "referringDomains", desc: true }}
            toolbar={toolbar}
            columns={columnsWithData(
              [
                { key: "url", label: "Page linked to", format: "url" },
                { key: "referringDomains", label: "Linking domains", format: "number" },
                { key: "dofollow", label: "Followed", format: "number" },
                { key: "topDomains", label: "Strongest linking domains", sortable: false },
                { key: "anchors", label: "Link text", sortable: false },
              ],
              pages,
            )}
          />
        </div>
        <p className="mt-2 text-xs text-muted">
          {formatNumber(pages.length)} pages, from the {formatNumber(res.data.items.length)} strongest of {formatNumber(res.data.total)} linking domains, one link from each.
        </p>
        <CostNote metas={[res.meta]} ttl="7 days" />
      </>
    );
  }
  const rows = res.data.items.map((l) => ({
    source: l.url_from,
    title: l.page_from_title,
    sourceRank: l.domain_from_rank,
    pageRank: l.rank,
    anchor: l.item_type === "image" ? "[image]" : l.anchor,
    target: l.url_to,
    rel: [l.dofollow ? "dofollow" : "nofollow", ...(l.attributes ?? []).filter((a) => a !== "nofollow")].join(" "),
    type: l.item_type,
    spamScore: l.backlink_spam_score,
    firstSeen: l.first_seen,
    lastSeen: l.last_seen,
    flag: l.is_broken ? "broken" : l.is_new ? "new" : l.is_lost ? "lost" : null,
  }));
  return (
    <>
      {header}
      <Briefing sentence={linksSentence(status, res.data.total, res.data.items)}>
        {linksFigures(status, res.data.total, res.data.items).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      <div className="mt-6">
        <DataTable
          filename={`backlinks-${target}`}
          rows={rows}
          initialSort={{ key: "sourceRank", desc: true }}
          toolbar={toolbar}
          columns={columnsWithData(
            [
              { key: "source", label: "Source page", format: "url" },
              { key: "sourceRank", label: "Domain strength", format: "number" },
              { key: "pageRank", label: "Link strength", format: "number" },
              { key: "anchor", label: "Link text" },
              { key: "target", label: "Links to", format: "url" },
              { key: "rel", label: "Link attributes" },
              { key: "spamScore", label: "Spam score", format: "number" },
              { key: "flag", label: "Status", format: "badge", sortable: false },
              { key: "firstSeen", label: "First seen", format: "date" },
              { key: "lastSeen", label: "Last seen", format: "date" },
            ],
            rows,
          )}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Showing {formatNumber(rows.length)} of {formatNumber(res.data.total)} (top {LIST_LIMIT} by source strength, a score out of 1,000).
      </p>
      <CostNote metas={[res.meta]} ttl="7 days" />
    </>
  );
}
