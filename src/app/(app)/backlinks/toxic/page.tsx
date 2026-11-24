import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Summary } from "@/components/ui/disclosure";
import { FigureView } from "@/components/ui/figure";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { currentTimeZone } from "@/lib/workspace/current";
import { getBacklinks, getReferringDomains, LIST_LIMIT, listDecisions, pendingUsd } from "@/modules/backlinks/api";
import { freshnessOf, reviewFigures, reviewSentence } from "@/modules/backlinks/brief";
import { BacklinksHeader, BacklinksInvalid, CostNote, FilterPills, onFreePlan, param, resolveTarget, RunNeeded, wantsRun } from "@/modules/backlinks/header";
import { buildReview, REVIEW_LABELS, type ReviewLabel } from "@/modules/backlinks/logic";
import { ReviewTable, type ReviewTableRow } from "@/modules/backlinks/review-table";

export const metadata = { title: "Link review" };

const LEAD = "Linking domains scored with simple, visible rules. Mark the ones to disavow, then download the file.";

export default async function ToxicPage({ searchParams }: PageProps<"/backlinks/toxic">) {
  const sp = await searchParams;
  const { target, invalid, project, isProjectDomain, workspaceId } = await resolveTarget(sp.q);
  if (invalid) return <BacklinksInvalid invalid={invalid} />;
  if (!target) return <NoProject />;
  const l = param(sp.label);
  const label = l === "risky" || l === "review" || l === "ok" || l === "all" ? l : "flagged";
  const projectId = isProjectDomain ? project!.id : null;

  return (
    <Suspense
      fallback={
        <>
          <Header target={target} projectId={projectId} description={LEAD} loading />
          <PageSkeleton header={false} label="Loading the link review" />
        </>
      }
    >
      <Review target={target} label={label} workspaceId={workspaceId} projectId={projectId} run={!(await onFreePlan()) && (await wantsRun(sp.run))} />
    </Suspense>
  );
}

function Header({ target, projectId, description, loading }: { target: string; projectId: number | null; description: string; loading?: boolean }) {
  return (
    <>
      <BacklinksHeader
        loading={loading}
        description={description}
        target={target}
        actions={
          projectId ? (
            // A file, not a page: never prefetched, and the browser saves it.
            <ButtonLink href={`/backlinks/toxic/disavow?project=${projectId}`} prefetch={false} variant="secondary" download>
              Download disavow.txt
            </ButtonLink>
          ) : undefined
        }
      />
      {!projectId && (
        <div className="mb-4">
          <Callout title="Read-only review">Keep and disavow decisions are saved per project, so they are only available for your current project&apos;s domain.</Callout>
        </div>
      )}
    </>
  );
}

async function Review({ target, label, workspaceId, projectId, run }: { target: string; label: ReviewLabel | "flagged" | "all"; workspaceId: number; projectId: number | null; run: boolean }) {
  let domains, links;
  try {
    [domains, links] = await Promise.all([
      getReferringDomains(target, { workspaceId, projectId, run }),
      getBacklinks(target, { onePerDomain: true, workspaceId, projectId, limit: LIST_LIMIT, run }),
    ]);
  } catch (e) {
    return (
      <>
        <Header target={target} projectId={projectId} description={LEAD} />
        <ApiError error={e} />
      </>
    );
  }
  if ("pending" in domains || "pending" in links) {
    return (
      <>
        <Header target={target} projectId={projectId} description={`${LEAD} Not loaded yet.`} />
        <RunNeeded what="The link review" target={target} costUsd={pendingUsd([domains, links])} basePath="/backlinks/toxic" params={{ q: target, label: label === "flagged" ? undefined : label }} ttl="7 days" />
      </>
    );
  }
  const decisions = projectId ? await listDecisions({ workspaceId, projectId }) : [];
  const decided = new Map(decisions.map((d) => [d.domain, d.decision as "keep" | "disavow"]));
  const review = buildReview(domains.data.items, links.data.items);
  const counts = { risky: 0, review: 0, ok: 0 };
  for (const r of review) counts[r.label]++;
  const disavowCount = projectId ? decisions.filter((d) => d.decision === "disavow").length : null;
  const timeZone = await currentTimeZone();

  const rows: ReviewTableRow[] = review
    .filter((r) => (label === "flagged" ? r.label !== "ok" : label === "all" ? true : r.label === label))
    .map((r) => ({
      domain: r.domain,
      label: r.label,
      labelText: REVIEW_LABELS[r.label],
      score: r.score,
      reasons: r.reasons.join(" · "),
      spamScore: r.spamScore,
      rank: r.rank,
      backlinks: r.backlinks,
      anchor: r.anchor,
      urlFrom: r.urlFrom,
      decision: decided.get(r.domain) ?? null,
    }));

  return (
    <>
      <Header target={target} projectId={projectId} description={`${LEAD} ${freshnessOf([domains.meta, links.meta], timeZone)}`} />
      <Briefing sentence={reviewSentence(counts, disavowCount)}>
        {reviewFigures(counts, disavowCount).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      <div className="mt-6">
        <ReviewTable
          rows={rows}
          projectId={projectId}
          filename={`link-review-${target}`}
          toolbar={
            <FilterPills
              basePath="/backlinks/toxic"
              params={{ q: target, label: label === "flagged" ? undefined : label }}
              name="label"
              label="Risk"
              options={[
                { value: "flagged", label: "Risky + to review" },
                { value: "risky", label: REVIEW_LABELS.risky },
                { value: "review", label: REVIEW_LABELS.review },
                { value: "ok", label: REVIEW_LABELS.ok },
                { value: "all", label: "All" },
              ]}
            />
          }
        />
      </div>
      <details className="group mt-3 text-xs text-muted">
        <Summary className="w-fit">How the score works</Summary>
        <p className="mt-2 max-w-3xl">
          Each rule adds points: provider spam score of 60+ (+40) or 30–59 (+20); a TLD common in link networks such as .shop, .site or .online (+20); a spammy
          anchor (SEO/backlink sellers, casino, pills, loans…) (+25); 50+ links from one domain (+15); three or more linking domains on the same /24 subnet, ignoring shared CDNs like Cloudflare (+15);
          domain rank under 10 of 1000 (+10). 50+ is Risky, 25–49 is To review, and anything lower is OK. Only disavow links you didn&apos;t build and can&apos;t get removed; Google ignores
          most spam on its own.
        </p>
      </details>
      <CostNote metas={[domains.meta, links.meta]} ttl="7 days" />
    </>
  );
}
