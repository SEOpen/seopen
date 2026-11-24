import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { chartDay } from "@/components/ui/module-card";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { ModuleTabs } from "@/components/ui/tabs";
import { checkGate } from "@/lib/billing/check-gate";
import { showsDollarCosts } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { checkIsMainAction, failureAgain, failureLink, lastTry, pageFailure } from "@/lib/check-failure";
import { formatDateTimeZoned, formatDay } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { zonedJobTime } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { dayRange, notConfirmedTitle } from "../brief";
import { rankFailure } from "../failure";
import { maxCheckCost } from "../metrics";
import { RANGES, type RankPlace, type TrackerState } from "../queries";
import { CheckNowForm } from "./check-now";

const TABS = [
  { href: "/rank", label: "Overview" },
  { href: "/rank/competitors", label: "Competitors" },
  { href: "/rank/pages", label: "Pages" },
  { href: "/rank/cannibalization", label: "Cannibalization" },
  { href: "/rank/settings", label: "Settings" },
];

/** Pages and Cannibalization only mean something once a check has landed, so they stay out of the row until then. */
const AFTER_RESULTS = new Set(["/rank/pages", "/rank/cannibalization"]);

export function RankTabs({ hasResults = true }: { hasResults?: boolean }) {
  return <ModuleTabs tabs={hasResults ? TABS : TABS.filter((t) => !AFTER_RESULTS.has(t.href))} />;
}

/** Query params that keep a page on the place it's showing. */
export const placeParams = (place: RankPlace): Record<string, string> => (place.current ? {} : { place: String(place.code) });

/**
 * Where these numbers were searched from, once there's more than one place to tell apart: the new
 * baseline after a move, with links to the checks from before it. `className` places it on the page.
 */
export function PlaceNotice({ state, path, params, className = "mb-4" }: { state: Pick<TrackerState, "place" | "places">; path: string; params?: Record<string, string>; className?: string }) {
  const { place, places } = state;
  const href = (p: RankPlace) => `${path}?${new URLSearchParams({ ...params, ...placeParams(p) })}`;
  const link = "text-accent hover:underline";
  if (!place.current) {
    const now = places.find((p) => p.current);
    return (
      <div className={className}>
        <Callout title={`Earlier checks from ${place.name}`}>
          {dayRange(place.first, place.last)}. This project now searches from {now?.name}, so these aren&apos;t compared with its newer checks. Estimated traffic uses
          today&apos;s search volumes.{" "}
          {now && (
            <Link href={href(now)} className={link}>
              Back to {now.name}
            </Link>
          )}
        </Callout>
      </div>
    );
  }
  const earlier = places.filter((p) => !p.current && p.checks > 0);
  if (!earlier.length) return null;
  return (
    <p className={cn("text-xs text-muted", className)}>
      {place.first ? `Searching from ${place.name} since ${formatDay(place.first)}.` : `The next check searches from ${place.name}.`} Positions differ by place, so earlier checks aren&apos;t compared:{" "}
      {earlier.map((p, i) => (
        <span key={p.code}>
          {i > 0 && ", "}
          <Link href={href(p)} className={link}>
            {p.name}
          </Link>{" "}
          ({dayRange(p.first, p.last)})
        </span>
      ))}
      .
    </p>
  );
}

/** 7d / 30d / 90d / 12m links that keep the other query params. */
export function RangePicker({ path, range, params }: { path: string; range: number; params?: Record<string, string> }) {
  return <SegmentedLinks label="Date range" options={RANGES.map((r) => ({ href: `${path}?${new URLSearchParams({ ...params, range: String(r.days) })}`, label: r.label, active: r.days === range }))} />;
}

/** "Check now" and "Deep check" buttons. The owner's workspace sees the most each can cost; a plan covers them for customers. */
export async function CheckNowButtons({ project, state }: { project: Project; state: TrackerState }) {
  const n = state.keywords.filter((k) => k.active).length;
  if (!n) return null;
  const [ws, gate, spend] = await Promise.all([currentWorkspace(), checkGate(project.workspaceId), spendState(project.workspaceId)]);
  const showCost = showsDollarCosts(ws);
  return (
    <CheckNowForm
      // The plan's refusal first: Free has no spend banner, but it runs no rank checks either.
      refused={(gate("rank", project.id) ?? spend.refusal)?.message}
      projectId={project.id}
      keywords={n}
      dailyDepth={state.settings.dailyDepth}
      sweepDepth={state.settings.sweepDepth}
      quickUsd={showCost ? maxCheckCost(n, state.settings.dailyDepth) : null}
      deepUsd={showCost ? maxCheckCost(n, state.settings.sweepDepth, true) : null}
      busy={!!state.activeRun}
      // Not the page's main action when a check just failed in a way running another can't fix.
      hasResults={!checkIsMainAction(state.dates.length > 0, pageFailure(latestFailure(state, "UTC"), gate("rank", project.id)))}
    />
  );
}

/** Whether the newest check failed, as these pages read it: a check in flight isn't a failure, and nothing tracked has nothing to check again. */
export function latestFailure(state: Pick<TrackerState, "activeRun" | "keywords" | "newestRun">, timeZone: string, now?: Date) {
  if (state.activeRun || !state.keywords.some((k) => k.active)) return null;
  return rankFailure(state.newestRun, timeZone, now);
}

/** Progress of a run in flight, a failed newest check, or the last finished check. */
export async function RunStatus({ state, resultsBelow = true }: { state: TrackerState; /** Whether this page shows the results, or only the runs. */ resultsBelow?: boolean }) {
  const run = state.activeRun;
  const timeZone = await currentTimeZone();
  if (run) {
    return (
      <div className="mb-4">
        <Callout title={run.status === "posting" ? "Posting check…" : "Check running"}>
          {run.status === "posting"
            ? "Sending your keywords to Google."
            : `${run.tasksDone} of ${run.tasksTotal} keywords checked (top ${run.depth} results${run.aiOverview ? ", with AI answers" : ""}). This usually takes a few minutes, and results appear as they arrive. A keyword that comes back missing or far lower is looked up again first, which adds a few minutes more. Reload to update.`}
        </Callout>
      </div>
    );
  }
  const failure = state.place.current ? pageFailure(latestFailure(state, timeZone), (await checkGate(state.settings.workspaceId))("rank", state.settings.projectId)) : null;
  if (failure) {
    // The newest day with results from this place, the one the sentence says. A check from before a move isn't results here.
    const newest = state.dates[0];
    return (
      <CheckFailureCallout
        title={`${lastTry(failure)} (${formatDateTimeZoned(failure.at, timeZone)})`}
        reason={failure.reason}
        from={newest && `${resultsBelow ? "Results below are" : "The latest results are"} from ${chartDay(newest)}.`}
        again={failureAgain(failure, "Check now runs it again.")}
        link={failureLink(failure)}
        stuck={failure.stuck}
      />
    );
  }
  const unconfirmed = state.lastRun?.notChecked ?? 0;
  if (unconfirmed) {
    return (
      <div className="mb-4">
        <Callout tone="warn" title={notConfirmedTitle(unconfirmed)}>
          Google&apos;s results left {unconfirmed === 1 ? "it" : "them"} out on every look, which often says more about the page Google served than about your ranking.{" "}
          {unconfirmed === 1 ? "It keeps its" : "They keep their"} last position until a look finds {unconfirmed === 1 ? "it" : "them"}, or for three days.
        </Callout>
      </div>
    );
  }
  return null;
}

/** Header status: when results last landed, that a check is in flight, or that the newest one failed. Never "Updated" over a failure. */
export function lastCheckedLabel(state: Pick<TrackerState, "activeRun" | "dates" | "keywords" | "lastRun" | "newestRun">, timeZone: string, now?: Date): string {
  const run = state.lastRun;
  const checking = state.activeRun ? (state.activeRun.status === "posting" ? "Starting a check…" : "Checking…") : null;
  const failure = latestFailure(state, timeZone, now);
  const failed = !!failure;
  // After a move, a good check from the old place isn't one here.
  if (failure && !state.dates.length) return `${lastTry(failure)}, no results yet`;
  if (!run) return checking ?? `Not checked yet, first check at ${zonedJobTime("06:00", timeZone)}`;
  if (checking) return `${checking} · last updated ${formatDateTimeZoned(run.finishedAt ?? run.createdAt, timeZone)}`;
  return `${failed ? "Last good check" : "Updated"} ${formatDateTimeZoned(run.finishedAt ?? run.createdAt, timeZone)}`;
}
