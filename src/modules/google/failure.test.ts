import { describe, expect, it, vi } from "vitest";
import { syncFailure, type SyncReading } from "./failure";

vi.mock("server-only", () => ({}));

const run = new Date("2026-11-07T10:00:00Z");
const reading = (over: Partial<SyncReading>): SyncReading => ({ provider: "Google", href: "/gsc", status: "ok", message: null, lastRunAt: run, accountNeedsReconnect: false, connectedAt: new Date("2026-11-01T00:00:00Z"), ...over });

describe("syncFailure", () => {
  it("asks for a reconnect when the account is marked, even before any sync row", () => {
    const f = syncFailure(reading({ status: undefined, lastRunAt: undefined, accountNeedsReconnect: true }), "UTC");
    expect(f).toMatchObject({ kind: "reconnect", provider: "Google", next: { label: "Reconnect", href: "/gsc" } });
  });

  it("asks for a reconnect on a refused sync, but not one older than the account's last connect", () => {
    expect(syncFailure(reading({ status: "reauth", message: "Reconnect Google to keep syncing." }), "UTC")).toMatchObject({ kind: "reconnect", reason: "Reconnect Google to keep syncing." });
    expect(syncFailure(reading({ status: "reauth", connectedAt: new Date("2026-11-07T11:00:00Z") }), "UTC")).toBeNull();
  });

  it("says a failed sync with its stored customer message", () => {
    expect(syncFailure(reading({ status: "error", message: "This sync didn't finish." }), "UTC")).toMatchObject({ kind: "failed", noun: "sync", day: "Nov 7", reason: "This sync didn't finish." });
  });

  it("isn't a failure while running, queued, rate limited or fine", () => {
    for (const status of ["ok", "idle", "queued", "running", "quota"]) expect(syncFailure(reading({ status }), "UTC")).toBeNull();
    expect(syncFailure(reading({ status: undefined, lastRunAt: undefined }), "UTC")).toBeNull();
  });

  it("says an Analytics source that syncs but has had no data for weeks has stopped, and what usually causes it", () => {
    const ga4 = reading({ provider: "Google", href: "/ga4", analytics: "GA4", checkedThrough: "2026-11-06", newestData: "2026-10-01" });
    expect(syncFailure(ga4, "UTC")).toMatchObject({
      kind: "stopped",
      since: "Oct 1",
      day: "Nov 7",
      retry: false,
      next: { label: "View", href: "/ga4" },
      reason: "SEOpen asked GA4 for every day through Nov 6, and the newest day with organic sessions is Oct 1. That usually means the GA4 tag came off the site, or this project reads the wrong GA4 property.",
    });
    expect(syncFailure({ ...ga4, provider: "PostHog", analytics: "PostHog" }, "UTC")?.reason).toContain("the PostHog snippet came off the site, or this project reads the wrong PostHog project.");
    expect(syncFailure({ ...ga4, provider: "Plausible", analytics: "Plausible" }, "UTC")?.reason).toContain("the Plausible script came off the site, or this project reads the wrong Plausible site.");
  });

  it("leaves a few quiet days alone, Search Console alone, and a failing sync to its own failure", () => {
    const ga4 = reading({ href: "/ga4", analytics: "GA4", checkedThrough: "2026-11-06", newestData: "2026-11-01" });
    expect(syncFailure(ga4, "UTC")).toBeNull();
    expect(syncFailure(reading({ checkedThrough: "2026-11-06", newestData: "2026-10-01" }), "UTC")).toBeNull();
    expect(syncFailure({ ...ga4, newestData: "2026-10-01", status: "error", message: "This sync didn't finish." }, "UTC")?.kind).toBe("failed");
  });
});
