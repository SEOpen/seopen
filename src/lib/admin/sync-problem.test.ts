import { describe, expect, it } from "vitest";
import { problemSync, syncLabel } from "./sync-problem";

const now = new Date("2026-11-02T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const base = { status: "ok", message: null, lastError: null, lastRunAt: daysAgo(0.5), lastSuccessAt: daysAgo(0.5) };

describe("problemSync", () => {
  it("passes a sync that succeeded today", () => {
    expect(problemSync(base, now)).toBeNull();
  });

  it("reports error, reauth and quota with the stored error", () => {
    expect(problemSync({ ...base, status: "error", lastError: "500 from Google" }, now)).toEqual({ kind: "error", detail: "500 from Google" });
    expect(problemSync({ ...base, status: "reauth" }, now)).toEqual({ kind: "reauth", detail: "Needs a reconnect" });
    expect(problemSync({ ...base, status: "quota", message: "Quota hit, retrying tomorrow" }, now)?.kind).toBe("quota");
  });

  it("reports a sync with no success for three days as stale", () => {
    expect(problemSync({ ...base, lastSuccessAt: daysAgo(2.9) }, now)).toBeNull();
    expect(problemSync({ ...base, lastSuccessAt: daysAgo(4) }, now)).toEqual({ kind: "stale", detail: "No success for 4 days" });
  });

  it("reports an Analytics sync that succeeds while its data stopped weeks ago, and leaves Search Console and quiet days alone", () => {
    const ga4 = { ...base, source: "ga4", latestDate: "2026-10-31", newestData: "2026-09-26" };
    expect(problemSync(ga4, now)).toEqual({ kind: "stopped", detail: "Syncs, but no data since Sep 26" });
    expect(problemSync({ ...ga4, source: "plausible" }, now)?.kind).toBe("stopped");
    expect(problemSync({ ...ga4, newestData: "2026-10-25" }, now)).toBeNull();
    expect(problemSync({ ...ga4, source: "gsc" }, now)).toBeNull();
    expect(problemSync({ ...ga4, status: "error", lastError: "500 from Google" }, now)?.kind).toBe("error");
  });

  it("reports a sync that ran but never succeeded, and skips one that never ran", () => {
    expect(problemSync({ ...base, lastSuccessAt: null, lastRunAt: daysAgo(5) }, now)?.detail).toBe("Ran 5 days ago and never succeeded");
    expect(problemSync({ ...base, status: "idle", lastSuccessAt: null, lastRunAt: null }, now)).toBeNull();
  });
});

describe("syncLabel", () => {
  it("names each source", () => {
    expect(["gsc", "ga4", "posthog", "plausible", "other"].map(syncLabel)).toEqual(["Search Console", "GA4", "PostHog", "Plausible", "other"]);
  });
});
