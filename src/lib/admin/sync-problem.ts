import { dataStopped } from "@/lib/check-failure";

/**
 * Pure: whether one sync needs the owner's attention. Syncs run daily, so one that hasn't
 * succeeded for STALE_SYNC_DAYS has stopped, whatever its status says.
 */

export const STALE_SYNC_DAYS = 3;

const LABELS: Record<string, string> = { gsc: "Search Console", ga4: "GA4", posthog: "PostHog", plausible: "Plausible", umami: "Umami" };
export const syncLabel = (source: string) => LABELS[source] ?? source;

export interface SyncProblem {
  /** "error" | "reauth" | "quota" | "stale" | "stopped" (an Analytics sync that works while its data stopped arriving) */
  kind: string;
  detail: string;
}

/** The sources that fill `ga4_landing_daily`, whose data can stop while their sync keeps working. */
const ANALYTICS = new Set(["ga4", "posthog", "plausible", "umami"]);

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function problemSync(
  row: {
    status: string;
    message: string | null;
    lastError: string | null;
    lastRunAt: Date | null;
    lastSuccessAt: Date | null;
    source?: string;
    /** The last day the sync asked for, and the newest day of stored data, for an Analytics source. */
    latestDate?: string | null;
    newestData?: string | null;
  },
  now = new Date(),
): SyncProblem | null {
  const detail = row.lastError ?? row.message ?? "";
  if (row.status === "reauth") return { kind: "reauth", detail: detail || "Needs a reconnect" };
  if (row.status === "error") return { kind: "error", detail: detail || "Failed" };
  if (row.status === "quota") return { kind: "quota", detail: detail || "Hit the API quota" };
  // A sync that has never run is still being set up, not stopped.
  const since = row.lastSuccessAt ?? row.lastRunAt;
  if (!since) return null;
  const days = (now.getTime() - since.getTime()) / 86_400_000;
  if (days < STALE_SYNC_DAYS) {
    // The same test the customer's pages use (DATA_STOPPED_DAYS), so Health and Overview agree.
    if (row.source && ANALYTICS.has(row.source) && row.newestData && dataStopped(row.latestDate, row.newestData)) return { kind: "stopped", detail: `Syncs, but no data since ${shortDay(row.newestData)}` };
    return null;
  }
  return { kind: "stale", detail: row.lastSuccessAt ? `No success for ${Math.floor(days)} days` : `Ran ${Math.floor(days)} days ago and never succeeded` };
}
