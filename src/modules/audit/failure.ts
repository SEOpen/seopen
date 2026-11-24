import { failedCheck, newestFailed, refusalFix, type CheckFailure, type CheckRow } from "@/lib/check-failure";
import { CRAWL_CANCELLED, plainCrawlSummary, storedFailureKind } from "@/lib/dataforseo/failure-copy";

/** The way forward from a failed crawl that isn't crawling again: Billing for a refusal, the project's domain for a rejected one. */
export function crawlFix(stored: string | null, projectId: number): { label: string; href: string } | null {
  const kind = storedFailureKind(stored);
  if (kind === "refusal") return refusalFix(stored ?? "");
  return kind === "rejected" ? { label: "Open Project settings", href: `/projects/${projectId}/settings` } : null;
}

/** Whether a project's newest crawl failed, in the customer's words. Stopping a crawl on purpose isn't a failure. Timed from when it started, as /audit says it. */
export function auditFailure(newest: CheckRow | null | undefined, projectId: number, timeZone: string): CheckFailure | null {
  const failed = newestFailed(newest ?? undefined);
  if (!failed || failed.stored === CRAWL_CANCELLED) return null;
  const { message, retry } = plainCrawlSummary(failed.stored);
  return failedCheck({ noun: "crawl", at: newest!.createdAt, timeZone, reason: message, retry, next: crawlFix(failed.stored, projectId) ?? { label: "View", href: "/audit" } });
}
