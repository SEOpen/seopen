import { describe, expect, it, vi } from "vitest";
import type { TrackerState } from "../queries";
import { lastCheckedLabel, latestFailure } from "./chrome";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workspace/current", () => ({ currentTimeZone: vi.fn(), currentWorkspace: vi.fn() }));
vi.mock("../actions", () => ({}));
vi.mock("./check-now", () => ({ CheckNowForm: () => null }));

const NOW = new Date("2026-11-07T12:00:00Z");
const NOV5 = new Date("2026-11-05T12:00:00Z");
const NOV7 = new Date("2026-11-07T10:00:00Z");

type Run = NonNullable<TrackerState["newestRun"]>;
const run = (status: string, at: Date, error: string | null = null) => ({ status, error, createdAt: at, finishedAt: at }) as unknown as Run;
const tracking = [{ active: true }] as unknown as TrackerState["keywords"];

const state = (over: Partial<Pick<TrackerState, "activeRun" | "dates" | "lastRun" | "newestRun" | "keywords">>) => ({ activeRun: null, dates: over.lastRun ? ["2026-11-05"] : [], lastRun: null, newestRun: null, keywords: tracking, ...over });

describe("lastCheckedLabel", () => {
  it("doesn't say Updated after the newest check failed", () => {
    const label = lastCheckedLabel(state({ lastRun: run("done", NOV5), newestRun: run("failed", NOV7) }), "UTC", NOW);
    expect(label).toMatch(/^Last good check Nov 5/);
    expect(label).not.toMatch(/Updated/);
  });

  it("doesn't say Not checked yet after a failed first check", () => {
    expect(lastCheckedLabel(state({ newestRun: run("failed", NOV7) }), "UTC", NOW)).toBe("Last check failed, no results yet");
  });

  it("doesn't call a good check from before a move the last good check here", () => {
    expect(lastCheckedLabel(state({ lastRun: run("done", NOV5), newestRun: run("failed", NOV7), dates: [] }), "UTC", NOW)).toBe("Last check failed, no results yet");
  });

  it("says a stuck first check didn't start", () => {
    const stuck = { status: "posting", error: null, createdAt: new Date(NOW.getTime() - 2 * 3_600_000) } as unknown as Run;
    expect(lastCheckedLabel(state({ newestRun: stuck }), "UTC", NOW)).toBe("Last check didn't start, no results yet");
  });

  it("clears once a newer check succeeds", () => {
    const newer = run("done", NOV7);
    expect(lastCheckedLabel(state({ lastRun: newer, newestRun: newer }), "UTC", NOW)).toMatch(/^Updated Nov 7/);
  });

  it("reads a check in flight and a project never checked as before", () => {
    const pending = run("pending", NOV7);
    expect(lastCheckedLabel(state({ activeRun: pending, newestRun: pending, lastRun: run("done", NOV5) }), "UTC", NOW)).toMatch(/^Checking… · last updated Nov 5/);
    expect(lastCheckedLabel(state({}), "UTC", NOW)).toMatch(/^Not checked yet, first check at/);
  });
});

describe("latestFailure", () => {
  it("is nothing when no keyword is tracked, so there's nothing to check again", () => {
    expect(latestFailure(state({ keywords: [], newestRun: run("failed", NOV7) }), "UTC", NOW)).toBeNull();
  });

  it("gives way to a check in flight", () => {
    expect(latestFailure(state({ activeRun: run("pending", NOV7), newestRun: run("failed", NOV5) }), "UTC", NOW)).toBeNull();
  });
});
