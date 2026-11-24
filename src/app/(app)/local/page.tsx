import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { Callout } from "@/components/ui/callout";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { PlanFeature, PlanFeatureCard } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { docsHelpHref } from "@/components/ui/tab-href";
import { checkGate } from "@/lib/billing/check-gate";
import { isFree, showsDollarCosts } from "@/lib/billing/gates";
import { failureAgain, failureLink, lastTry, noResultsBecause, pageFailure, type CheckFailure } from "@/lib/check-failure";
import { formatDateTimeZoned, formatShortDate } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { comparedStats, LIST_WAITING, localFigures, localSentence, rankDelta, type KeywordReading } from "@/modules/local/brief";
import { FindListingForm } from "@/modules/local/components/forms";
import { BusinessesTable, type BusinessRow } from "@/modules/local/components/tables";
import { localFailure } from "@/modules/local/failure";
import { gridLabel } from "@/modules/local/grid";
import { addStats, avgRank, EMPTY_STATS, foundLabel, rankChange, top3Share } from "@/modules/local/metrics";
import { checkStats, latestPair, listBusinesses, listChecks, listKeywords } from "@/modules/local/queries";
import type { LocalCheck } from "@/modules/local/tracker";

export const metadata = { title: "Local SEO" };

/** A business's last try for its row in the table: "failed Nov 7". */
const failureAs = (f: CheckFailure | null) => f && `${f.stuck ? "didn't start" : "failed"} ${f.day}`;

const ranAt = (c: LocalCheck) => (c.finishedAt ?? c.createdAt).getTime();
const newest = (checks: LocalCheck[]) => (checks.length ? new Date(Math.max(...checks.map(ranAt))) : null);

export default async function LocalPage() {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const scope = projectScope(project);
  const [ws, timeZone, businesses, gate] = await Promise.all([currentWorkspace(), currentTimeZone(), listBusinesses(scope), checkGate(project.workspaceId)]);
  const ids = businesses.map((b) => b.id);
  const [keywords, checks] = await Promise.all([listKeywords(scope, ids), listChecks(scope, ids, 200)]);
  const pairs = new Map(businesses.map((b) => [b.id, latestPair(checks, b.id)]));
  const stats = await checkStats(
    scope,
    [...pairs.values()]
      .flatMap((p) => [p.latest, p.previous])
      .filter((c) => c != null)
      .map((c) => c.id),
  );
  const showUsd = showsDollarCosts(ws);
  // Free has no research credits, which Local SEO's lookups and checks use.
  const free = isFree(ws);

  // Newest first, so the first of a business's rows is its newest: only that says whether it's failing.
  const failureOf = (id: number) => (keywords.some((k) => k.businessId === id) ? pageFailure(localFailure(checks.find((c) => c.businessId === id), id, timeZone), gate("local", project.id)) : null);

  const readings: KeywordReading[] = [];
  const rows: BusinessRow[] = businesses.map((b) => {
    const { latest, previous } = pairs.get(b.id)!;
    const kws = keywords.filter((k) => k.businessId === b.id);
    const mine: KeywordReading[] = latest
      ? kws.map((k) => ({
          cur: stats.get(`${latest.id}:${k.id}`) ?? EMPTY_STATS,
          prev: previous ? stats.get(`${previous.id}:${k.id}`) : null,
        }))
      : [];
    readings.push(...mine);
    const total = latest ? addStats(mine.map((r) => r.cur)) : null;
    const avg = total ? avgRank(total) : null;
    const compared = comparedStats(mine);
    const change = compared ? rankChange(compared.cur, compared.prev) : null;
    return {
      id: b.id,
      title: b.title,
      address: b.address,
      grid: gridLabel(b.gridSize, b.radiusMiles),
      keywords: kws.length,
      avgRank: avg == null ? null : Math.round(avg * 10) / 10,
      change,
      delta: rankDelta(change),
      top3: total ? top3Share(total) : null,
      found: total ? foundLabel(total) : "–",
      lastChecked: latest ? (latest.finishedAt ?? latest.createdAt).toISOString() : null,
      lastTry: failureAs(failureOf(b.id)),
    };
  });

  const latests = [...pairs.values()].map((p) => p.latest).filter((c) => c != null);
  const at = newest(latests);
  const previousAt = newest([...pairs.values()].map((p) => p.previous).filter((c) => c != null));
  const figures = at ? localFigures({ rows: readings, previousAt, timeZone }) : [];
  const failing = businesses.flatMap((b) => {
    const failure = failureOf(b.id);
    return failure ? [{ id: b.id, title: b.title, failure, from: pairs.get(b.id)!.latest }] : [];
  });

  return (
    <>
      <PageHeader
        title="Local SEO"
        description={
          <>
            Where your Google Maps listing ranks across a grid of points around it, on a phone, for the searches you choose.
            {at && ` ${failing.length ? "Last good check" : "Last check"} ${formatDateTimeZoned(at, timeZone)}.`}
          </>
        }
        helpHref={docsHelpHref("/local")}
      />
      <FailedChecks failing={failing} timeZone={timeZone} />
      {!businesses.length && free ? (
        <PlanFeature module="local" />
      ) : !businesses.length ? (
        <div className="module-rail">
          <EmptyState
            title="No business tracked yet"
            description={`Find your Google Maps listing by name and city. SEOpen then searches each keyword from a grid of points around it (5×5 across 5 miles to start) and shows where you appear, who beats you, and how that changes week to week.`}
          />
          <AddBusiness projectId={project.id} showUsd={showUsd} first />
        </div>
      ) : (
        <>
          <Briefing sentence={at ? localSentence({ rows: readings, at, previousAt, timeZone, newerFailed: failing.length > 0 }) : failing.length ? noResultsBecause(failing.find((f) => !f.failure.stuck)?.failure ?? failing[0].failure) : LIST_WAITING}>
            {figures.length > 0 ? figures.map((f) => <FigureView key={f.id} data={f} />) : null}
          </Briefing>
          <Section title="Businesses" description={`The ${failing.length ? "last good" : "latest"} check of each, across all its keywords.`}>
            <BusinessesTable rows={rows} />
          </Section>
          <div className="mt-8 max-w-2xl">{free ? <PlanFeatureCard title="Add a business" module="local" /> : <AddBusiness projectId={project.id} showUsd={showUsd} />}</div>
        </>
      )}
    </>
  );
}

/** The businesses whose newest check failed, under one callout however many there are. Each business's own page has the button. */
function FailedChecks({ failing, timeZone }: { failing: { id: number; title: string; failure: CheckFailure; from: LocalCheck | null }[]; timeZone: string }) {
  if (!failing.length) return null;
  const fromOn = (from: LocalCheck | null) => (from ? ` Results below are from ${formatShortDate(from.finishedAt ?? from.createdAt, timeZone)}.` : "");
  if (failing.length === 1) {
    const [{ id, title, failure, from }] = failing;
    return (
      <CheckFailureCallout
        title={`${lastTry(failure)} for ${title} (${formatDateTimeZoned(failure.at, timeZone)})`}
        reason={failure.reason}
        from={fromOn(from).trim() || null}
        again={failureAgain(failure, null)}
        link={failureLink(failure) ?? { label: `Open ${title}`, href: `/local/${id}` }}
        stuck={failure.stuck}
      />
    );
  }
  return (
    <div className="mb-4">
      <Callout tone={failing.every((f) => f.failure.stuck) ? "warn" : "bad"} title={`The latest checks ${failing.every((f) => f.failure.stuck) ? "didn't start" : failing.some((f) => f.failure.stuck) ? "didn't finish" : "failed"} for ${failing.length} businesses`}>
        <ul className="grid gap-1.5">
          {failing.map(({ id, title, failure, from }) => (
            <li key={id}>
              <Link href={failureLink(failure)?.href ?? `/local/${id}`} className="font-medium text-accent hover:underline">
                {title}
              </Link>
              : {failureAs(failure)}. {failure.stuck ? null : failure.reason}
              {fromOn(from)}
              {failure.blocked && ` ${failure.blocked}`}
            </li>
          ))}
        </ul>
      </Callout>
    </div>
  );
}

function AddBusiness({ projectId, showUsd, first }: { projectId: number; showUsd: boolean; first?: boolean }) {
  return (
    <Card>
      <CardHeader title="Add a business" description="Search Google Maps by the business name and city, then pick the right listing." />
      <CardBody>
        <FindListingForm projectId={projectId} showUsd={showUsd} first={first} />
      </CardBody>
    </Card>
  );
}
