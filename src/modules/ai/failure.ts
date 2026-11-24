import { failedCheck, newestFailed, refusalFix, type CheckFailure, type CheckRow } from "@/lib/check-failure";
import type { LastCall } from "@/lib/dataforseo/client";
import { plainAiFailure, plainAioFailure, plainCallFailure, storedFailureKind } from "@/lib/dataforseo/failure-copy";

/** The way forward from a failed run that isn't running it again: Billing for a refusal, the prompts for a rejected one. */
export function aiFix(stored: string | null): { label: string; href: string } | null {
  const kind = storedFailureKind(stored);
  if (kind === "refusal") return refusalFix(stored ?? "");
  return kind === "rejected" ? { label: "Open Prompts", href: "/ai/prompts" } : null;
}

/** What Run now would do after a failed run, unless the reason already says it or running it again can't help. */
export function aiRunAgain(stored: string | null): string | null {
  return storedFailureKind(stored) === "other" && !/again/i.test(plainAiFailure(stored)) ? "Run now runs it again." : null;
}

/** /ai's header: when the answers are from. Never "Last run" or "Not run yet" over a failed run. */
export function aiRunLabel(lastRun: string | null, failure: CheckFailure | null): string {
  if (lastRun) return `${failure ? "Answers from" : "Last run"} ${lastRun}`;
  return failure ? "Last run failed" : "Not run yet";
}

/** Whether a project's newest AI run failed, in the customer's words. Timed from when it started, as /ai says it. */
export function aiFailure(newest: CheckRow | null | undefined, timeZone: string): CheckFailure | null {
  const failed = newestFailed(newest ?? undefined);
  if (!failed) return null;
  return failedCheck({
    noun: "run",
    at: newest!.createdAt,
    timeZone,
    reason: plainAiFailure(failed.stored),
    retry: storedFailureKind(failed.stored) === "other",
    next: aiFix(failed.stored) ?? { label: "View", href: "/ai" },
    stuck: failed.stuck,
  });
}

/** A weekly AI Overview check that couldn't run, as /ai says it over the numbers from before it. The next run checks again. */
export function aioFailure(f: { at: Date; stored: string | null }, timeZone: string): CheckFailure {
  return failedCheck({ noun: "check", at: f.at, timeZone, reason: plainAioFailure(f.stored), retry: false, next: aiFix(f.stored) ?? { label: "View", href: "/ai" } });
}

/** A Mentions refresh that failed, from the call the ledger kept. The next run refreshes it again. */
export function mentionsCheckFailure(call: LastCall, timeZone: string): CheckFailure {
  return failedCheck({ noun: "check", at: call.at, timeZone, reason: plainCallFailure(call.statusCode, call.endpoint).message, retry: false, next: { label: "View", href: "/ai" } });
}
