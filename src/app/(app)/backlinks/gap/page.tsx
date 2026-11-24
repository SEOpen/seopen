import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { Input } from "@/components/ui/input";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { PlanFeature } from "@/components/ui/plan-feature";
import { formatNumber } from "@/lib/format";
import { listCompetitors, normalizeDomain } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { GAP_LIMIT, getCompetitorGap, isPending, pendingUsd } from "@/modules/backlinks/api";
import { freshnessOf, gapFigures, gapHiddenNote, gapSentence } from "@/modules/backlinks/brief";
import { BacklinksHeader, BacklinksInvalid, CostNote, onFreePlan, param, resolveTarget, RunNeeded, spendRefusal, wantsRun } from "@/modules/backlinks/header";
import { columnsWithData, ELEVATED_SPAM, estimateCostUsd, mergeGap, prepareGap } from "@/modules/backlinks/logic";
import { isHostname } from "@/modules/domains/transform";
import { LookupButton } from "@/modules/keywords/components/lookup-button";
import { maxCostLabel } from "@/modules/keywords/format";
import type { LookupQuote } from "@/modules/keywords/lookup-quote";

export const metadata = { title: "Link gap" };

const MAX_COMPETITORS = 5;

/** The Note on a row `isBroadLinker` marks: why it sits after the rest. */
const BROAD_NOTE = "Links to every competitor";

const lead = (target: string) => `Domains that link to competitors but not to ${target}: outreach prospects.`;

export default async function GapPage({ searchParams }: PageProps<"/backlinks/gap">) {
  const sp = await searchParams;
  const { target, invalid, project, isProjectDomain, workspaceId } = await resolveTarget(sp.q);
  if (invalid) return <BacklinksInvalid invalid={invalid} />;
  if (!target) return <NoProject />;
  const vsParam = param(sp.vs);
  const listed = vsParam ? vsParam.split(/[\s,]+/).map(normalizeDomain) : isProjectDomain ? await listCompetitors(projectScope(project!)) : [];
  // The form spends as it submits, so a typed word or a repeat never reaches a lookup.
  const competitors = [...new Set(listed)].filter((d) => isHostname(d) && d !== target).slice(0, MAX_COMPETITORS);

  if (competitors.length === 0) {
    // Free has no research credits: it's told what Starter adds instead of offered a lookup it would refuse.
    if (await onFreePlan()) {
      return (
        <>
          <BacklinksHeader description={lead(target)} target={target} />
          <PlanFeature module="backlinks" />
        </>
      );
    }
    return (
      <>
        <BacklinksHeader description={lead(target)} target={target} />
        <EmptyState
          title="No competitors to compare"
          description="Add competitors to your project, or type some domains below."
          action={
            project ? (
              <ButtonLink href={`/projects/${project.id}/settings`} prefetch={false} variant="secondary">
                Edit project competitors
              </ButtonLink>
            ) : undefined
          }
        />
        <CompareForm target={target} competitors={competitors} costUsd={estimateCostUsd(GAP_LIMIT)} first refused={await spendRefusal()} />
      </>
    );
  }

  return (
    <Suspense
      fallback={
        <>
          <BacklinksHeader description={lead(target)} target={target} loading />
          <PageSkeleton header={false} label="Loading the link gap" />
        </>
      }
    >
      <Gap target={target} competitors={competitors} vs={vsParam} workspaceId={workspaceId} projectId={isProjectDomain ? project!.id : null} run={!(await onFreePlan()) && (await wantsRun(sp.run))} />
    </Suspense>
  );
}

/**
 * A lookup you've just typed: the cost is on the button and it doesn't ask twice, so submitting runs the
 * comparison. Primary only when the page has nothing else to offer. `costUsd` is for the competitors as
 * loaded, and the button follows the field from there. Clearing the field goes back to the project's own
 * competitors when `projectList` is set, so that's priced at the most it can be.
 */
function CompareForm({
  target,
  competitors,
  costUsd,
  projectList = false,
  first = false,
  refused,
}: {
  target: string;
  competitors: string[];
  costUsd: number;
  projectList?: boolean;
  first?: boolean;
  refused: string | undefined;
}) {
  const quote: LookupQuote = {
    kind: "linkGap",
    byCount: Array.from({ length: MAX_COMPETITORS + 1 }, (_, n) => maxCostLabel(estimateCostUsd(GAP_LIMIT) * (n || (projectList ? MAX_COMPETITORS : 1)))),
  };
  return (
    <Card className="mt-8">
      <CardHeader title="Competitors to compare" description={`Up to ${MAX_COMPETITORS}. Each one is looked up once and kept for 7 days.`} />
      <CardBody>
        {/* Keyed on what it loaded: a link to another comparison keeps this page mounted, and the field and price must start over. */}
        <form key={`${target}|${competitors.join()}`} method="get" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="q" value={target} />
          <input type="hidden" name="run" value="1" />
          <Input name="vs" defaultValue={competitors.join(", ")} placeholder="competitor1.com, competitor2.com" className="max-w-xl flex-[1_1_16rem]" aria-label="Competitor domains" />
          <LookupButton label={maxCostLabel(costUsd)} quote={quote} quiet={!first} refused={refused}>
            Compare
          </LookupButton>
        </form>
      </CardBody>
    </Card>
  );
}

async function Gap({ target, competitors, vs, workspaceId, projectId, run }: { target: string; competitors: string[]; vs: string | undefined; workspaceId: number; projectId: number | null; run: boolean }) {
  const [refused, free] = await Promise.all([spendRefusal(), onFreePlan()]);
  // The form spends as it submits, so Free doesn't get it.
  const compareForm = (costUsd: number) => (free ? null : <CompareForm target={target} competitors={competitors} costUsd={costUsd} projectList={projectId != null} refused={refused} />);
  let fetched;
  try {
    fetched = await Promise.all(competitors.map((c) => getCompetitorGap(c, target, { workspaceId, projectId, run })));
  } catch (e) {
    return (
      <>
        <BacklinksHeader description={lead(target)} target={target} />
        <ApiError error={e} />
        {compareForm(estimateCostUsd(GAP_LIMIT) * competitors.length)}
      </>
    );
  }
  const missing = competitors.filter((_, i) => isPending(fetched[i]));
  if (missing.length) {
    return (
      <>
        <BacklinksHeader description={`${lead(target)} Not loaded yet.`} target={target} />
        <RunNeeded what={`The link gap against ${missing.join(", ")}`} target={target} costUsd={pendingUsd(fetched)} basePath="/backlinks/gap" params={{ q: target, vs }} ttl="7 days" />
        {compareForm(pendingUsd(fetched))}
      </>
    );
  }
  const results = fetched.flatMap((r, i) => (isPending(r) ? [] : [{ competitor: competitors[i], ...r }]));
  // The link_gap tool's prospects, with spam kept and listed last. What's left out is named under the table.
  const gap = prepareGap(mergeGap(results.map((r) => ({ competitor: r.competitor, items: r.data }))), target, competitors, { includeSpam: true });
  const rows = gap.rows.map((r) => ({ ...r, note: r.broadLinker ? BROAD_NOTE : undefined }));
  const hidden = gapHiddenNote(gap, target);
  const timeZone = await currentTimeZone();

  return (
    <>
      <BacklinksHeader description={`${lead(target)} ${freshnessOf(results.map((r) => r.meta), timeZone)}`} target={target} />
      <Briefing sentence={gapSentence(rows, competitors, target)}>
        {gapFigures(rows, competitors, GAP_LIMIT).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      <div className="mt-6">
        <DataTable
          filename={`link-gap-${target}`}
          // No initial sort: the rows come in prepareGap's order, which sorting by Links to would undo.
          rows={rows as unknown as Record<string, unknown>[]}
          columns={columnsWithData(
            [
              { key: "domain", label: "Domain", format: "link", href: "/backlinks?q={domain}" },
              { key: "note", label: "Note", format: "badge", sortable: false },
              { key: "competitorCount", label: "Links to", format: "number" },
              { key: "competitors", label: "Competitors" },
              { key: "rank", label: "Link strength", format: "number" },
              { key: "backlinks", label: "Backlinks to them", format: "number" },
              { key: "spamScore", label: "Spam score", format: "number" },
              { key: "firstSeen", label: "First seen", format: "date" },
            ],
            rows as unknown as Record<string, unknown>[],
          )}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        {formatNumber(rows.length)} prospects from the top {GAP_LIMIT} referring domains of each competitor. Domains linking to more competitors are listed first,
        {rows.some((r) => r.broadLinker) ? " sites that link to every competitor after them," : ""} and those with a spam score of {ELEVATED_SPAM} or more last.
      </p>
      {hidden && <p className="mt-1 text-xs text-muted">{hidden}</p>}
      <CostNote metas={results.map((r) => r.meta)} ttl="7 days" />
      {compareForm(0)}
    </>
  );
}
