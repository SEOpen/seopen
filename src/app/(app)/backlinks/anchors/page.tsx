import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { FilterBar } from "@/components/ui/filter-bar";
import { DataTable } from "@/components/ui/data-table";
import { FigureView } from "@/components/ui/figure";
import { Input } from "@/components/ui/input";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Section } from "@/components/ui/section";
import { formatNumber, formatPct } from "@/lib/format";
import { currentTimeZone } from "@/lib/workspace/current";
import { getAnchors } from "@/modules/backlinks/api";
import { anchorShares, anchorsFigures, anchorsSentence, freshnessOf } from "@/modules/backlinks/brief";
import { BacklinksHeader, BacklinksInvalid, CostNote, onFreePlan, param, resolveTarget, RunNeeded, wantsRun } from "@/modules/backlinks/header";
import { brandTerm, classifyAnchor, columnsWithData, type AnchorClass } from "@/modules/backlinks/logic";

export const metadata = { title: "Anchors" };

const CLASS_HELP: Record<AnchorClass, string> = {
  branded: "mentions the brand",
  url: "a bare URL or hostname",
  exact: "equals one of your keywords",
  partial: "contains one of your keywords",
  generic: "“click here”, “website”, empty",
  other: "anything else",
};

const lead = (target: string) => `Link text pointing to ${target}, sorted into types with our own rules.`;

const KEYWORDS_ID = "main-keywords";

export default async function AnchorsPage({ searchParams }: PageProps<"/backlinks/anchors">) {
  const sp = await searchParams;
  const { target, invalid, project, isProjectDomain, workspaceId } = await resolveTarget(sp.q);
  if (invalid) return <BacklinksInvalid invalid={invalid} />;
  if (!target) return <NoProject />;
  const kw = param(sp.kw) ?? "";
  const keywords = kw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  return (
    <Suspense
      fallback={
        <>
          <BacklinksHeader description={lead(target)} target={target} loading />
          <PageSkeleton header={false} label="Loading anchors" />
        </>
      }
    >
      <Anchors target={target} keywords={keywords} kw={kw} workspaceId={workspaceId} projectId={isProjectDomain ? project!.id : null} run={!(await onFreePlan()) && (await wantsRun(sp.run))} />
    </Suspense>
  );
}

/** A GET form, free: the keywords only change how the rows already loaded are sorted. */
function KeywordsForm({ target, kw }: { target: string; kw: string }) {
  return (
    <FilterBar id={KEYWORDS_ID} className="mb-0 scroll-mt-6 items-center gap-x-2 text-sm">
      <input type="hidden" name="q" value={target} />
      <label htmlFor={`${KEYWORDS_ID}-input`} className="text-secondary">
        Your main keywords
      </label>
      <Input id={`${KEYWORDS_ID}-input`} name="kw" defaultValue={kw} placeholder="Comma separated" className="h-[30px] max-w-80 flex-[1_1_12rem]" />
      <span className="w-full text-xs text-muted">Brand term: “{brandTerm(target)}”. Keywords turn on the exact and partial types.</span>
    </FilterBar>
  );
}

async function Anchors({ target, keywords, kw, workspaceId, projectId, run }: { target: string; keywords: string[]; kw: string; workspaceId: number; projectId: number | null; run: boolean }) {
  let res;
  try {
    res = await getAnchors(target, { workspaceId, projectId, run });
  } catch (e) {
    return (
      <>
        <BacklinksHeader description={lead(target)} target={target} />
        <ApiError error={e} />
      </>
    );
  }
  if ("pending" in res) {
    return (
      <>
        <BacklinksHeader description={`${lead(target)} Not loaded yet.`} target={target} />
        <RunNeeded what="Anchors" target={target} costUsd={res.estimateUsd} basePath="/backlinks/anchors" params={{ q: target, kw: kw || undefined }} ttl="7 days" />
        {/* On Free nothing will load here, so there are no rows to sort. */}
        {!(await onFreePlan()) && (
          <div className="mt-6">
            <KeywordsForm target={target} kw={kw} />
          </div>
        )}
      </>
    );
  }
  const rows = res.data.items.map((a) => ({
    anchor: a.anchor || "(empty)",
    class: classifyAnchor(a.anchor, target, keywords),
    backlinks: a.backlinks,
    referringDomains: a.referring_domains,
    dofollow: a.referring_domains ? 1 - (a.referring_domains_nofollow ?? 0) / a.referring_domains : null,
    spamScore: a.backlinks_spam_score,
    firstSeen: a.first_seen,
  }));
  const { count, share } = anchorShares(rows);
  const classes = (Object.keys(CLASS_HELP) as AnchorClass[]).sort((a, b) => count(b) - count(a));
  const largest = Math.max(1, count(classes[0]));
  const timeZone = await currentTimeZone();

  return (
    <>
      <BacklinksHeader description={`${lead(target)} ${freshnessOf([res.meta], timeZone)}`} target={target} />
      <Briefing sentence={anchorsSentence(rows, res.data.total)}>
        {/* A full path, not a bare hash: a bare hash would keep run=1 from the current URL. */}
        {anchorsFigures(rows, res.data.total, keywords.length > 0, `/backlinks/anchors?q=${encodeURIComponent(target)}#${KEYWORDS_ID}`).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      <div className="mt-6">
        <DataTable
          filename={`anchors-${target}`}
          rows={rows}
          initialSort={{ key: "backlinks", desc: true }}
          columns={columnsWithData(
            [
              { key: "anchor", label: "Link text" },
              { key: "class", label: "Type", format: "badge" },
              { key: "backlinks", label: "Backlinks", format: "number" },
              { key: "referringDomains", label: "Domains", format: "number" },
              { key: "dofollow", label: "Followed", format: "pct" },
              { key: "spamScore", label: "Spam score", format: "number" },
              { key: "firstSeen", label: "First seen", format: "date" },
            ],
            rows,
          )}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        {formatNumber(rows.length)} of {formatNumber(res.data.total)} link texts.
      </p>

      <Section title="Link text by type" description={rows.length < res.data.total ? `Shares of the backlinks under the ${formatNumber(rows.length)} link texts shown.` : "Shares of all backlinks."}>
        <ul className="flex flex-col gap-3 text-sm">
          {classes.map((c) => (
            <li key={c} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_3rem] items-center gap-3">
              <div className="min-w-0">
                <div className="capitalize">{c}</div>
                <div className="text-xs text-muted">{CLASS_HELP[c]}</div>
              </div>
              <span className="h-2 overflow-hidden rounded-sm bg-surface-2">
                <span className="block h-full rounded-sm bg-secondary" style={{ width: `${(count(c) / largest) * 100}%` }} />
              </span>
              <span className="data text-right">{formatPct(share(c), 0)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-5">
          <KeywordsForm target={target} kw={kw} />
        </div>
      </Section>
      <CostNote metas={[res.meta]} ttl="7 days" />
    </>
  );
}
