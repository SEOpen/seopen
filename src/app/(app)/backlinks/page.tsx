import { Suspense, type ReactNode } from "react";
import { ApiError } from "@/components/api-error";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { Briefing } from "@/components/ui/briefing";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { EmptyState } from "@/components/ui/empty-state";
import { PlanFeature } from "@/components/ui/plan-feature";
import { FigureView } from "@/components/ui/figure";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Section } from "@/components/ui/section";
import { Trend } from "@/components/ui/trend";
import { isFree } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { failureAgain, failureLink, lastTry, pageFailure } from "@/lib/check-failure";
import { formatDate, formatDateTimeZoned, formatDay, formatNumber, formatPct } from "@/lib/format";
import { currentTimeZone } from "@/lib/workspace/current";
import { refreshOverview } from "@/modules/backlinks/actions";
import { getNewLost, getReferringDomains, getSummary, listSnapshots, pendingUsd, snapshotFailures } from "@/modules/backlinks/api";
import {
  domainSpamRow,
  monthSentence,
  monthSpan,
  newDomainSpam,
  overviewFigures,
  overviewFreshness,
  overviewSentence,
  readingBefore,
  readingDay,
  type LinkReading,
  type NewSpam,
} from "@/modules/backlinks/brief";
import { BacklinksHeader, BacklinksInvalid, CostNote, onFreePlan, resolveTarget, RunNeeded, wantsRun } from "@/modules/backlinks/header";
import { dofollowShare, estimateCostUsd, toNewLostSeries } from "@/modules/backlinks/logic";
import { NewLostChart } from "@/modules/backlinks/new-lost-chart";
import { RefreshButton } from "@/modules/backlinks/refresh-button";
import { costLabel } from "@/modules/keywords/format";

export const metadata = { title: "Backlinks" };

type Snapshots = Awaited<ReturnType<typeof listSnapshots>>;

interface Target {
  target: string;
  workspaceId: number;
  projectId: number | null;
}

export default async function BacklinksPage({ searchParams }: PageProps<"/backlinks">) {
  const sp = await searchParams;
  const { target, invalid, project, isProjectDomain, workspaceId } = await resolveTarget(sp.q);
  if (invalid) return <BacklinksInvalid invalid={invalid} />;
  if (!target) return <NoProject />;
  const t: Target = { target, workspaceId, projectId: isProjectDomain ? project!.id : null };

  return (
    <Suspense
      fallback={
        <>
          <Header {...t} loading />
          <PageSkeleton header={false} label="Loading backlinks" />
        </>
      }
    >
      {/* Free never asks to spend, so a run=1 address only reads what's already saved. */}
      <Overview {...t} run={!(await onFreePlan()) && (await wantsRun(sp.run))} />
    </Suspense>
  );
}

/**
 * `refresh`: off while a Run prompt is on the page, so the same data isn't offered at two prices. Also off
 * in the loading fallback, where it isn't known yet whether that prompt is coming.
 */
function Header({ target, projectId, freshness, loading, refresh = true, refused }: Target & { freshness?: string; loading?: boolean; refresh?: boolean; refused?: string }) {
  const cost = costLabel(estimateCostUsd(1) + estimateCostUsd(13));
  return (
    <BacklinksHeader
      loading={loading}
      description={
        <>
          Link profile for <span className="font-medium text-fg">{target}</span>
          {projectId && " (your project)"}.{freshness && ` ${freshness}`}
        </>
      }
      target={target}
      actions={
        refresh && !loading ? (
          <ActionForm action={refreshOverview.bind(null, target, projectId)} align="end">
            <RefreshButton cost={cost} target={target} refused={refused} />
          </ActionForm>
        ) : undefined
      }
    />
  );
}

const reading = (s: Snapshots[number]): LinkReading => ({ date: s.date, backlinks: s.backlinks, referringDomains: s.referringDomains, rank: s.rank, spamScore: s.spamScore });

/**
 * The referring domains new since the earlier reading and how many score high for spam, from the
 * referring-domain list when it's already cached. A cache-only read, so it never spends.
 */
async function spamSince(target: string, workspaceId: number, projectId: number, before: LinkReading | null): Promise<NewSpam | null> {
  if (!before) return null;
  const list = await getReferringDomains(target, { workspaceId, projectId, run: false });
  if ("pending" in list) return null;
  return newDomainSpam(
    list.data.items.map((d) => ({ firstSeen: d.first_seen, spamScore: d.backlinks_spam_score })),
    before.date,
  );
}

/** A label and its number, kept quiet so they don't compete with the strip. */
function AlsoCounted({ items }: { items: [string, string][] }) {
  return (
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt>{label}</dt>
          <dd className="data text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Referring domains and backlinks apart, because the larger count flattens the smaller on one axis. */
function History({ snapshots }: { snapshots: Snapshots }) {
  if (!snapshots.length) return null;
  return (
    <Section title="Snapshot history" description="Saved each time fresh numbers load, and once a week.">
      <div className="grid gap-x-8 gap-y-6 @3xl/main:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-medium">Referring domains</h3>
          <Trend points={snapshots.map((r) => ({ date: r.date, value: r.referringDomains }))} label="Referring domains" noun="snapshot" height={200} />
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-medium">Backlinks</h3>
          <Trend points={snapshots.map((r) => ({ date: r.date, value: r.backlinks }))} label="Backlinks" noun="snapshot" height={200} />
        </div>
      </div>
    </Section>
  );
}

function Pair({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-8 @3xl/main:grid-cols-2">{children}</div>;
}

async function Overview({ target, workspaceId, projectId, run }: Target & { run: boolean }) {
  const { refusal, workspace } = await spendState(workspaceId);
  const t = { target, workspaceId, projectId, refused: refusal?.message };
  const reviewHref = `/backlinks/toxic?q=${encodeURIComponent(target)}`;
  let summary, newLost;
  try {
    [summary, newLost] = await Promise.all([getSummary(target, { workspaceId, projectId, run }), getNewLost(target, { workspaceId, projectId, run })]);
  } catch (e) {
    return (
      <>
        <Header {...t} />
        <ApiError error={e} />
      </>
    );
  }
  if ("pending" in summary || "pending" in newLost) {
    // The dashboard reads stored snapshots, so this page shows them too rather than saying nothing's there.
    const [stored, timeZone] = await Promise.all([projectId ? listSnapshots({ workspaceId, projectId }) : [], currentTimeZone()]);
    // A weekly snapshot or refresh that couldn't run leaves these numbers older than the last try.
    const failed = projectId ? (await snapshotFailures(workspaceId, [projectId], timeZone)).get(projectId) : undefined;
    const failure = failed ? pageFailure(failed, refusal) : null;
    const last = stored.at(-1);
    const prev = stored.at(-2);
    const spam = last && projectId ? await spamSince(target, workspaceId, projectId, prev ? reading(prev) : null) : null;
    const also: [string, string][] = [["Followed links", formatPct(last?.dofollowShare)]];
    if (last?.nofollowBacklinks != null) also.push(["Marked nofollow", formatNumber(last.nofollowBacklinks)]);
    return (
      <>
        <Header {...t} refresh={false} freshness={last ? `Stored numbers from ${formatDay(last.date)}.` : "Not loaded yet."} />
        {failure?.at && (
          <CheckFailureCallout
            title={`${lastTry(failure)} (${formatDateTimeZoned(failure.at, timeZone)})`}
            reason={failure.reason}
            from={last && `These are the ${formatDay(last.date)} numbers.`}
            again={failureAgain(failure, null)}
            link={failureLink(failure)}
          />
        )}
        {last && (
          <>
            <Briefing sentence={overviewSentence(reading(last), prev ? reading(prev) : null, spam)}>
              {overviewFigures(reading(last), prev ? reading(prev) : null, true, reviewHref, spam).map((f) => (
                <FigureView key={f.id} data={f} />
              ))}
            </Briefing>
            <AlsoCounted items={also} />
          </>
        )}
        {/* Free has no research credits: it's told what Starter adds instead of offered a lookup it would refuse. */}
        {isFree(workspace) ? (
          <PlanFeature module="backlinks" />
        ) : (
          <RunNeeded
            what={last ? "The rest of the overview" : "The backlink overview"}
            target={target}
            costUsd={pendingUsd([summary, newLost])}
            basePath="/backlinks"
            params={{ q: target }}
            ttl="24 hours (summary) and 7 days (trend)"
            missing={last ? "New and lost links by month, domain endings and the link profile" : undefined}
          />
        )}
        <History snapshots={stored} />
      </>
    );
  }
  const timeZone = await currentTimeZone();
  const freshness = overviewFreshness(summary.meta, newLost.meta, timeZone);
  const s = summary.data;
  if (!s) {
    return (
      <>
        <Header {...t} freshness={freshness} />
        <EmptyState title="No backlink data" description={`Our link index has no backlinks for ${target}.`} />
      </>
    );
  }

  const snapshots = projectId ? await listSnapshots({ workspaceId, projectId }) : [];
  const day = readingDay(summary.meta);
  const before = readingBefore(snapshots, day);
  const now: LinkReading = { date: day, backlinks: s.backlinks, referringDomains: s.referring_domains, rank: s.rank, spamScore: s.backlinks_spam_score };
  const spam = projectId ? await spamSince(target, workspaceId, projectId, before) : null;
  const series = toNewLostSeries(newLost.data);
  const hasMoves = (kind: "domains" | "backlinks") => series.some((p) => (kind === "domains" ? p.newDomains || p.lostDomains : p.newBacklinks || p.lostBacklinks));
  const tlds = Object.entries(s.referring_links_tld ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const tldTotal = Object.values(s.referring_links_tld ?? {}).reduce((n, v) => n + v, 0);
  const profile: [string, string][] = [
    ["Followed links", formatPct(dofollowShare(s))],
    ["Marked nofollow", formatNumber(s.referring_links_attributes?.nofollow ?? 0)],
    ["Main domains linking here", formatNumber(s.referring_main_domains)],
    ["Separate IP addresses", formatNumber(s.referring_ips)],
    ["Separate networks (subnets)", formatNumber(s.referring_subnets)],
    ["Broken backlinks", formatNumber(s.broken_backlinks)],
    ["Text / image links", `${formatNumber(s.referring_links_types?.anchor ?? 0)} / ${formatNumber(s.referring_links_types?.image ?? 0)}`],
    domainSpamRow(s.info?.target_spam_score),
    ["First seen", formatDate(s.first_seen, timeZone)],
  ];

  return (
    <>
      <Header {...t} freshness={freshness} />
      <Briefing sentence={projectId ? overviewSentence(now, before, spam) : monthSentence(series)}>
        {overviewFigures(now, before, !!projectId, reviewHref, spam).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>

      <Pair>
        <Section title="Referring domains, new vs lost" description={monthSpan(series)}>
          {hasMoves("domains") ? <NewLostChart data={series} kind="domains" /> : <p className="text-sm text-secondary">No changes recorded.</p>}
        </Section>
        <Section title="Backlinks, new vs lost" description={monthSpan(series)}>
          {hasMoves("backlinks") ? <NewLostChart data={series} kind="backlinks" /> : <p className="text-sm text-secondary">No changes recorded.</p>}
        </Section>
      </Pair>

      <Pair>
        <Section title="Domain endings" description="Where links come from. A pile-up of .shop, .site or .online often means a link network.">
          <ul className="flex flex-col gap-2 text-sm">
            {tlds.map(([tld, n]) => (
              <li key={tld} className="grid grid-cols-[5rem_minmax(0,1fr)_3.5rem] items-center gap-3">
                <span className="truncate text-secondary">.{tld}</span>
                <span className="h-2 overflow-hidden rounded-sm bg-surface-2">
                  <span className="block h-full rounded-sm bg-secondary" style={{ width: `${(n / (tlds[0]?.[1] || 1)) * 100}%` }} />
                </span>
                <span className="data text-right">{formatPct(n / (tldTotal || 1), 0)}</span>
              </li>
            ))}
            {!tlds.length && <li className="text-secondary">No data</li>}
          </ul>
        </Section>
        <Section title="Profile">
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2 text-sm">
            {profile.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-secondary">{label}</dt>
                <dd className="data text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </Pair>

      <History snapshots={snapshots} />

      <CostNote metas={[summary.meta, newLost.meta]} ttl="24 hours (summary) and 7 days (trend)" />
    </>
  );
}
