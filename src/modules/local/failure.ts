import { failedCheck, newestFailed, refusalFix, type CheckFailure, type CheckRow } from "@/lib/check-failure";
import { plainLocalFailure, storedFailureKind } from "@/lib/dataforseo/failure-copy";

/** Whether a business's newest check failed, in the customer's words. Null when it succeeded, is running or never ran. */
export function localFailure(newest: CheckRow | null | undefined, businessId: number, timeZone: string, now?: Date): CheckFailure | null {
  const failed = newestFailed(newest ?? undefined, { stalePosting: true, now });
  if (!failed) return null;
  const kind = storedFailureKind(failed.stored);
  return failedCheck({
    noun: "check",
    at: failed.at,
    timeZone,
    reason: plainLocalFailure(failed.stored),
    retry: kind === "other",
    next: (kind === "refusal" && refusalFix(failed.stored ?? "")) || { label: "View", href: `/local/${businessId}` },
    stuck: failed.stuck,
  });
}

/** Every business's newest check on one project as one source, since a project shows one line per source. */
export function projectLocalFailure(failures: CheckFailure[]): CheckFailure | null {
  if (failures.length < 2) return failures[0] ?? null;
  const newest = [...failures].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0];
  const stuck = failures.every((f) => f.stuck);
  return { ...newest, stuck, reason: `The latest checks ${stuck ? "didn't start" : "failed"} for ${failures.length} businesses.`, next: newest.retry ? { label: "View", href: "/local" } : newest.next };
}
