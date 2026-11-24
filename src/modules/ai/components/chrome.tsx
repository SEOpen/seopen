import { Callout } from "@/components/ui/callout";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { ModuleTabs } from "@/components/ui/tabs";
import { checkGate } from "@/lib/billing/check-gate";
import { isInternal, showsDollarCosts } from "@/lib/billing/gates";
import { failureAgain, failureLink, pageFailure, withoutRetryAdvice } from "@/lib/check-failure";
import { formatDateTimeZoned, formatShortDate, formatUsd } from "@/lib/format";
import type { ProjectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { activeRun, latestAnswerAt, listRuns } from "../data";
import { aiFailure, aiRunAgain } from "../failure";
import { AutoRefresh } from "./run-controls";

export function AiTabs() {
  return (
    <ModuleTabs
      tabs={[
        { href: "/ai", label: "Overview" },
        { href: "/ai/actions", label: "Actions" },
        { href: "/ai/prompts", label: "Prompts" },
        { href: "/ai/sources", label: "Sources" },
        { href: "/ai/brands", label: "Brands" },
      ]}
    />
  );
}

/**
 * Progress of the run in flight (auto-refreshing), or the last run's failure. `canRun`: whether this
 * page has a Run now that could start one. `answersAt`: when the answers on this page are from, if
 * the page already knows, so its header and this can't name two dates.
 */
export async function RunStatus({ scope, canRun = true, answersAt }: { scope: ProjectScope; canRun?: boolean; answersAt?: Date | null }) {
  const [run, timeZone] = await Promise.all([activeRun(scope), currentTimeZone()]);
  if (run) {
    const showCost = showsDollarCosts(await currentWorkspace());
    return (
      <div className="mb-5">
        <AutoRefresh active />
        <Callout title={run.status === "queued" ? "Run queued" : `Run in progress: ${run.tasksDone} of ${run.tasksTotal || "…"} answers in`}>
          Started {formatDateTimeZoned(run.startedAt, timeZone)}
          {showCost && <> · estimated {formatUsd(run.estimatedCostUsd, 3)}</>}. Answers arrive over a few minutes, a few at a time. This page
          refreshes on its own.
        </Callout>
      </div>
    );
  }
  const [last] = await listRuns(scope, 1);
  if (last?.status === "failed") {
    const [ws, gate, latest] = await Promise.all([currentWorkspace(), checkGate(scope.workspaceId), answersAt === undefined ? latestAnswerAt(scope) : answersAt]);
    const failure = pageFailure(aiFailure({ status: last.status, error: last.error, createdAt: last.startedAt }, timeZone), gate("ai", scope.projectId))!;
    const reason = isInternal(ws) && last.error ? last.error : canRun ? failure.reason : withoutRetryAdvice(failure.reason);
    return (
      <CheckFailureCallout
        title={`Last run failed (${formatDateTimeZoned(last.startedAt, timeZone)})`}
        reason={reason}
        from={latest && `Answers are from ${formatShortDate(latest, timeZone)}.`}
        again={failureAgain(failure, canRun ? aiRunAgain(last.error) : null)}
        link={failureLink(failure)}
      />
    );
  }
  return null;
}

export { Bar } from "./bar";
