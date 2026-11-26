import Link from "next/link";
import { notFound } from "next/navigation";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { BackLink } from "@/components/ui/back-link";
import { Briefing } from "@/components/ui/briefing";
import { Callout } from "@/components/ui/callout";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { showsDollarCosts } from "@/lib/billing/gates";
import { checkGate } from "@/lib/billing/check-gate";
import { spendState } from "@/lib/billing/spend";
import { checkIsMainAction, failureAgain, failureLink, isStalePosting, lastTry, noResultsBecause, pageFailure, POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { plainCheckReason, plainLocalFailure } from "@/lib/dataforseo/failure-copy";
import { formatDateTime, formatDateTimeZoned, formatNumber, formatShortDate } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { removeKeyword } from "@/modules/local/actions";
import { businessLine, localFigures, localSentence, localWaiting, rankDelta, type KeywordReading } from "@/modules/local/brief";
import { AddKeywordsForm, CheckNowForm, GridSettingsForm, RemoveBusinessForm } from "@/modules/local/components/forms";
import { localFailure } from "@/modules/local/failure";
import { GridMap } from "@/modules/local/components/grid-map";
import { HistoryTable, KeywordsTable, type HistoryRow, type KeywordRow } from "@/modules/local/components/tables";
import { gridLabel } from "@/modules/local/grid";
import { avgRank, competitorsAcrossGrid, EMPTY_STATS, foundLabel, rankChange, top3Share, type KeywordStats } from "@/modules/local/metrics";
import { checkStats, listChecks, listKeywords, loadPoints, previousFor, withResults, type LocalKeyword } from "@/modules/local/queries";
import { googleStaticMapFor, staticMapHref } from "@/modules/local/static-map";
import { CHECK_EVERY_DAYS, getBusiness, type LocalBusiness, type LocalCheck } from "@/modules/local/tracker";

export const metadata = { title: "Local SEO" };

const num = (v: string | string[] | undefined) => (typeof v === "string" ? Number(v) : NaN);

export default async function LocalBusinessPage({ params, searchParams }: PageProps<"/local/[businessId]">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const scope = projectScope(project);
  const business = await getBusiness(scope, Number((await params).businessId));
  if (!business) notFound();
  const sp = await searchParams;
  const [ws, timeZone, keywords, checks, gate, spend] = await Promise.all([currentWorkspace(), currentTimeZone(), listKeywords(scope, [business.id]), listChecks(scope, [business.id], 52), checkGate(project.workspaceId), spendState(project.workspaceId)]);
  const when = (c: LocalCheck) => formatDateTime(c.finishedAt ?? c.createdAt, timeZone);
  const whenZoned = (c: LocalCheck) => formatDateTimeZoned(c.finishedAt ?? c.createdAt, timeZone);
  const showUsd = showsDollarCosts(ws);
  // A check stuck posting isn't in flight: the next one closes it, so it mustn't hold the button back.
  const active = checks.find((c) => (c.status === "posting" || c.status === "pending") && !isStalePosting(c)) ?? null;
  const failure = !active && keywords.length ? pageFailure(localFailure(checks[0], business.id, timeZone), gate("local", project.id)) : null;
  const shown = withResults(checks);
  // The check on screen: the one picked from History, else the newest with results, else the one running.
  const check = shown.find((c) => c.id === num(sp.check)) ?? shown[0] ?? active;
  const keyword = keywords.find((k) => k.id === num(sp.k)) ?? keywords[0] ?? null;
  const stats = await checkStats(scope, checks.map((c) => c.id));
  // The map is a client component, so a customer's page never receives the vendor's text at all.
  const points = (check && keyword ? await loadPoints(scope, check.id, keyword.id) : []).map((p) => (showUsd ? p : { ...p, error: plainCheckReason(p.error) }));
  const ours = { cid: business.cid, placeId: business.placeId };
  const latestDone = shown[0] ?? null;
  const link = (q: { k?: number; check?: number }) => {
    const p = new URLSearchParams();
    const k = q.k ?? keyword?.id;
    const c = q.check ?? (check && check.id !== shown[0]?.id ? check.id : undefined);
    if (k) p.set("k", String(k));
    if (c) p.set("check", String(c));
    const s = p.toString();
    return `/local/${business.id}${s ? `?${s}` : ""}`;
  };

  // The sentence and figures describe the check on screen, against the one with results before it.
  const position = check ? shown.findIndex((c) => c.id === check.id) : -1;
  const previous = position >= 0 ? (shown[position + 1] ?? null) : null;
  const previousAt = previous ? (previous.finishedAt ?? previous.createdAt) : null;
  const readings: KeywordReading[] = keywords.map((k) => {
    const prev = check ? previousFor(checks, check, k.id, stats) : null;
    return { cur: (check && stats.get(`${check.id}:${k.id}`)) || EMPTY_STATS, prev: prev ? stats.get(`${prev.id}:${k.id}`) : null };
  });
  const figures = position >= 0 ? localFigures({ rows: readings, previousAt, timeZone }) : [];

  const place = [business.address, business.category].filter(Boolean).join(" · ");

  return (
    <>
      <BackLink href="/local">Local SEO</BackLink>
      <PageHeader
        title={business.title}
        description={
          <>
            {place && <p>{place}</p>}
            <p>{businessLine({ gridSize: business.gridSize, radiusMiles: business.radiusMiles, everyDays: business.scheduled ? CHECK_EVERY_DAYS : null, lastChecked: latestDone ? whenZoned(latestDone) : null, failed: !!failure })}</p>
          </>
        }
        actions={
          <CheckNowForm
            projectId={project.id}
            businessId={business.id}
            gridSize={business.gridSize}
            keywords={keywords.length}
            busy={!!active}
            // Not the page's main action when a check just failed in a way running another can't fix.
            hasResults={!checkIsMainAction(shown.length > 0, failure)}
            showUsd={showUsd}
            refused={spend.refusal?.message}
          />
        }
      />
      {active && <RunningCallout check={active} />}
      {failure && (
        <CheckFailureCallout
          title={`${lastTry(failure)} (${formatDateTimeZoned(failure.at, timeZone)})`}
          reason={failure.reason}
          from={latestDone && `Results below are from ${formatShortDate(latestDone.finishedAt ?? latestDone.createdAt, timeZone)}.`}
          again={failureAgain(failure, "Check now runs it again.")}
          link={failureLink(failure)}
          stuck={failure.stuck}
        />
      )}

      {!keywords.length ? (
        <>
          <div className="module-rail">
            <EmptyState
              title="Add the searches you want to win"
              description={`Each keyword is searched on Google Maps from every point of the ${business.gridSize}×${business.gridSize} grid, as a phone would search it. Try the service and the city, the way customers search.`}
            />
            <KeywordsCard projectId={project.id} business={business} keywords={keywords} />
          </div>
          <ListingNote projectId={project.id} business={business} className="mt-6" />
        </>
      ) : (
        <>
          <Briefing
            sentence={
              position >= 0 && check
                ? localSentence({ rows: readings, at: check.finishedAt ?? check.createdAt, previousAt, timeZone, latest: position === 0, newerFailed: !!failure })
                : localWaiting({ running: !!active, scheduled: business.scheduled, noResults: failure && noResultsBecause(failure) })
            }
          >
            {figures.length > 0 ? figures.map((f) => <FigureView key={f.id} data={f} />) : null}
          </Briefing>

          <Section
            title={keyword ? `“${keyword.keyword}”` : "Grid"}
            description={
              check
                ? `${check.id === shown[0]?.id ? (failure ? "Last good check" : "Latest check") : "Check"} of ${whenZoned(check)} · ${gridLabel(check.gridSize, check.radiusMiles)}${check.kind === "scheduled" ? " · scheduled" : ""}`
                : failure
                  ? `The last check ${failure.stuck ? "didn't start" : "failed"}, so the grid is empty.`
                  : "Not checked yet. Run a check to fill the grid."
            }
          >
            {keywords.length > 1 && <KeywordPicker keywords={keywords} current={keyword?.id} link={link} />}
            {check && points.length ? (
              <GridMap
                key={`${check.id}:${keyword?.id}`}
                points={points}
                center={{ lat: check.lat, lng: check.lng }}
                gridSize={check.gridSize}
                ours={ours}
                title={business.title}
                googleMap={googleStaticMapFor(ws) && keyword ? staticMapHref(business.id, check.id, keyword.id) : null}
              />
            ) : (
              <p className="text-sm text-secondary">
                {check
                  ? "This keyword wasn't part of this check."
                  : failure
                    ? `The map fills in once a check succeeds.${failure.retry ? " Press Check now to try again." : ""}`
                    : `The map fills in once the first check runs. Press Check now${business.scheduled ? ", or wait for the weekly check" : ""}.`}
              </p>
            )}
          </Section>

          <KeywordTable business={business} keywords={keywords} checks={checks} check={check} stats={stats} current={keyword?.id} />

          {check && points.length > 0 && <Competitors points={points} ours={ours} keyword={keyword!.keyword} />}

          <History business={business} checks={checks} current={check} keyword={keyword} stats={stats} link={link} showUsd={showUsd} when={when} />

          <div className="mt-8 grid items-start gap-6 @3xl/main:grid-cols-2">
            <KeywordsCard projectId={project.id} business={business} keywords={keywords} />
            <Card>
              <CardHeader title="Grid and schedule" description="Centred on your listing. Changes apply from the next check; past checks keep their grid." />
              <CardBody>
                <GridSettingsForm
                  projectId={project.id}
                  businessId={business.id}
                  gridSize={business.gridSize}
                  radiusMiles={business.radiusMiles}
                  scheduled={business.scheduled}
                  keywords={keywords.length}
                  showUsd={showUsd}
                />
                <ListingNote projectId={project.id} business={business} className="mt-5 border-t border-line pt-4" />
              </CardBody>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/** How the listing is recognised, and the way to stop tracking it. */
function ListingNote({ projectId, business, className }: { projectId: number; business: LocalBusiness; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)}>
      <p className="text-xs text-muted">Matched on Google&apos;s own id for this listing{business.cid ? ` (${business.cid})` : ""}, not its name.</p>
      <RemoveBusinessForm projectId={projectId} businessId={business.id} title={business.title} />
    </div>
  );
}

function RunningCallout({ check }: { check: LocalCheck }) {
  return (
    <div className="mb-4">
      <Callout title={check.status === "posting" ? "Starting a check…" : "Check running"}>
        {check.status === "posting"
          ? "Sending the searches to Google Maps."
          : `${check.tasksDone + check.tasksFailed} of ${check.tasksTotal} points in. Google Maps results usually land within a few minutes; reload to update.`}
      </Callout>
    </div>
  );
}

function KeywordPicker({ keywords, current, link }: { keywords: LocalKeyword[]; current?: number; link: (q: { k?: number }) => string }) {
  return (
    <nav aria-label="Keyword" className="mb-3 flex flex-wrap gap-1">
      {keywords.map((k) => (
        <Link
          key={k.id}
          href={link({ k: k.id })}
          prefetch={false}
          aria-current={k.id === current ? "true" : undefined}
          className={cn(
            "flex min-h-7 items-center rounded-md px-2.5 py-1 text-xs transition-colors duration-[120ms] ease-instrument focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
            k.id === current ? "bg-accent-subtle text-accent" : "bg-surface-2/70 text-muted hover:text-fg",
          )}
        >
          {k.keyword}
        </Link>
      ))}
    </nav>
  );
}

/** One row per keyword, from the check on screen, compared with that keyword's previous check. */
function KeywordTable({
  business,
  keywords,
  checks,
  check,
  stats,
  current,
}: {
  business: LocalBusiness;
  keywords: LocalKeyword[];
  checks: LocalCheck[];
  check: LocalCheck | null;
  stats: Map<string, KeywordStats>;
  current?: number;
}) {
  if (!check) return null;
  const done = withResults(checks);
  const rows: KeywordRow[] = keywords.map((k) => {
    const s = stats.get(`${check.id}:${k.id}`) ?? EMPTY_STATS;
    const prev = previousFor(checks, check, k.id, stats);
    const last = done.find((c) => (stats.get(`${c.id}:${k.id}`)?.answered ?? 0) > 0);
    const avg = avgRank(s);
    const change = prev ? rankChange(s, stats.get(`${prev.id}:${k.id}`)) : null;
    return {
      id: k.id,
      businessId: business.id,
      keyword: k.keyword,
      avgRank: avg == null ? null : Math.round(avg * 10) / 10,
      top3: top3Share(s),
      found: s.total ? foundLabel(s) : "–",
      change,
      delta: rankDelta(change),
      lastChecked: last ? (last.finishedAt ?? last.createdAt).toISOString() : null,
    };
  });
  return (
    <Section title="Keywords" description="Average rank counts the points where you appear in the top 20. Found is out of the points Maps answered; failed points are listed apart and never count as not found.">
      <KeywordsTable rows={rows} businessId={business.id} current={current} />
    </Section>
  );
}

function Competitors({ points, ours, keyword }: { points: Parameters<typeof competitorsAcrossGrid>[0]; ours: { cid: string | null; placeId: string | null }; keyword: string }) {
  const list = competitorsAcrossGrid(points, ours, 10);
  if (!list.length) return null;
  const answered = list[0].answered;
  const rows = list.map((c) => ({
    business: c.ours ? `${c.title} (you)` : c.title,
    category: c.category,
    present: `${c.present}/${answered}`,
    presentN: c.present,
    avgRank: Math.round(c.avgRank * 10) / 10,
    rating: c.rating != null ? `★ ${c.rating.toFixed(1)}${c.votes != null ? ` (${formatNumber(c.votes)})` : ""}` : null,
  }));
  return (
    <Section title="Top competitors across the grid" description={`Businesses Google Maps listed for “${keyword}”, by how many points they appear at, then their average rank there.`}>
      <DataTable
        rows={rows}
        filename="local-competitors"
        searchable={false}
        columns={[
          { key: "business", label: "Business" },
          ...(rows.some((r) => r.category) ? [{ key: "category", label: "Category" }] : []),
          { key: "present", label: "Points present", align: "right" as const, sortable: false },
          { key: "avgRank", label: "Avg. rank", format: "position" as const, align: "right" as const },
          ...(rows.some((r) => r.rating) ? [{ key: "rating", label: "Rating", align: "right" as const, sortable: false }] : []),
        ]}
      />
    </Section>
  );
}

function KeywordsCard({ projectId, business, keywords }: { projectId: number; business: LocalBusiness; keywords: LocalKeyword[] }) {
  return (
    <Card>
      <CardHeader title="Keywords" description="One per line or comma separated. Repeats are dropped." />
      <CardBody className="flex flex-col gap-4">
        {keywords.length > 0 && (
          <ul className="divide-y divide-line border-y border-line">
            {keywords.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-sm">
                <span className="min-w-0 truncate">{k.keyword}</span>
                <ActionForm action={removeKeyword.bind(null, projectId, business.id, k.id)} align="end">
                  <ConfirmSubmit variant="ghost" question={`Remove “${k.keyword}” and its history?`} confirmLabel="Remove" aria-label={`Remove ${k.keyword}`}>
                    Remove
                  </ConfirmSubmit>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
        <AddKeywordsForm projectId={projectId} businessId={business.id} />
      </CardBody>
    </Card>
  );
}

function History({
  business,
  checks,
  current,
  keyword,
  stats,
  link,
  showUsd,
  when,
}: {
  business: LocalBusiness;
  checks: LocalCheck[];
  current: LocalCheck | null;
  keyword: LocalKeyword | null;
  stats: Map<string, KeywordStats>;
  link: (q: { check?: number }) => string;
  showUsd: boolean;
  when: (c: LocalCheck) => string;
}) {
  if (!checks.length) return null;
  const rows: HistoryRow[] = checks.map((c) => {
    const s = keyword ? (stats.get(`${c.id}:${keyword.id}`) ?? EMPTY_STATS) : EMPTY_STATS;
    const usable = c.status === "done" || (c.status === "pending" && c.tasksDone > 0);
    const avg = avgRank(s);
    const stuck = isStalePosting(c);
    const reason = showUsd ? c.error : plainCheckReason(c.error) ?? (c.error === POSTING_NEVER_FINISHED ? plainLocalFailure(c.error) : null);
    return {
      id: c.id,
      at: (c.finishedAt ?? c.createdAt).toISOString(),
      when: when(c),
      href: usable ? link({ check: c.id }) : null,
      current: c.id === current?.id,
      note: `${c.kind === "scheduled" ? "scheduled" : "manual"}${stuck ? " · didn't start" : c.status === "failed" ? ` · failed${reason ? `: ${reason}` : ""}` : c.status !== "done" ? " · running" : ""}`,
      grid: gridLabel(c.gridSize, c.radiusMiles),
      avgRank: avg == null ? null : Math.round(avg * 10) / 10,
      top3: s.answered ? top3Share(s) : null,
      found: s.total ? foundLabel(s) : "–",
      ...(showUsd ? { costUsd: c.costUsd } : {}),
    };
  });
  return (
    <Section title="History" description={`Every check is kept. Pick one to show it on the map${keyword ? ` (figures for “${keyword.keyword}”)` : ""}.`}>
      <HistoryTable rows={rows} businessId={business.id} showUsd={showUsd} />
    </Section>
  );
}
