import { failedCheck, newestFailed, refusalFix, type CheckFailure, type CheckRow } from "@/lib/check-failure";
import { plainRankRunFailure, storedFailureKind } from "@/lib/dataforseo/failure-copy";

/** Whether a project's newest rank run failed, in the customer's words. Null when it succeeded, is running or never ran. */
export function rankFailure(newest: CheckRow | null | undefined, timeZone: string, now?: Date): CheckFailure | null {
  const failed = newestFailed(newest ?? undefined, { stalePosting: true, now });
  if (!failed) return null;
  const kind = storedFailureKind(failed.stored);
  return failedCheck({
    noun: "check",
    at: failed.at,
    timeZone,
    reason: plainRankRunFailure(failed.stored),
    retry: kind === "other",
    next: (kind === "refusal" && refusalFix(failed.stored ?? "")) || { label: "View", href: "/rank" },
    stuck: failed.stuck,
  });
}
