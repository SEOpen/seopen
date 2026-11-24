import { describe, expect, it } from "vitest";
import { cronAuthorized } from "./cron-auth";
import type { WorkerHeartbeat } from "./heartbeat";
import { WATCH_STALE_MINUTES, WORKER_STALE_MINUTES, workerAlertMessage, workerProblems, workerStatus, type WorkerWatch } from "./worker-watch";

const T = new Date("2026-11-16T05:40:00Z");
const at = (minutes: number) => new Date(T.getTime() + minutes * 60_000);
const beat = (minutes: number, over: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat => ({ at: at(minutes).toISOString(), startedAt: at(-600).toISOString(), jobs: 28, ...over });
const watch = (checked: number, first = -60): WorkerWatch => ({ checkedAt: at(checked).toISOString(), firstCheckedAt: at(first).toISOString(), down: null });

describe("workerStatus", () => {
  it("is up while the last beat is younger than the stale limit", () => {
    expect(workerStatus(beat(0), null, at(0))).toMatchObject({ state: "up", jobs: 28 });
    expect(workerStatus(beat(0), null, at(WORKER_STALE_MINUTES - 1))).toMatchObject({ state: "up" });
  });

  it("is down from the stale limit on, with the minutes since the last beat", () => {
    expect(workerStatus(beat(0), null, at(WORKER_STALE_MINUTES))).toEqual({ state: "down", lastBeatAt: beat(0).at, minutes: WORKER_STALE_MINUTES });
    expect(workerStatus(beat(0), null, at(600))).toMatchObject({ state: "down", minutes: 600 });
  });

  it("waits on a database with no beat until the watch has looked for the stale limit", () => {
    expect(workerStatus(null, null, at(0))).toEqual({ state: "waiting" });
    expect(workerStatus(null, at(0).toISOString(), at(WORKER_STALE_MINUTES - 1))).toEqual({ state: "waiting" });
    expect(workerStatus(null, at(0).toISOString(), at(WORKER_STALE_MINUTES))).toEqual({ state: "down", lastBeatAt: null, minutes: null });
  });
});

describe("workerProblems", () => {
  it("has nothing to say about a worker that's up and watched", () => {
    expect(workerProblems({ beat: beat(0), watch: watch(0) }, at(3), true)).toEqual([]);
  });

  it("says a stale worker is down, since its last beat", () => {
    const [row] = workerProblems({ beat: beat(0), watch: watch(10) }, at(47), true);
    expect(row).toMatchObject({ problem: "Down", at: beat(0).at });
    expect(row.detail).toContain("No heartbeat for 47 minutes");
    expect(row.detail).toContain("worker's logs");
  });

  it("says a database that has never had a beat has no heartbeat, at once", () => {
    expect(workerProblems({ beat: null, watch: null }, at(0), false)).toEqual([expect.objectContaining({ problem: "No heartbeat", at: null })]);
  });

  it("says the watch has stopped only where a Vercel cron should run it", () => {
    expect(workerProblems({ beat: beat(0), watch: null }, at(1), true)).toEqual([expect.objectContaining({ problem: "Watch not running", at: null })]);
    expect(workerProblems({ beat: beat(0), watch: watch(-WATCH_STALE_MINUTES) }, at(0), true)).toEqual([expect.objectContaining({ problem: "Watch not running" })]);
    expect(workerProblems({ beat: beat(0), watch: watch(-WATCH_STALE_MINUTES + 1) }, at(0), true)).toEqual([]);
    expect(workerProblems({ beat: beat(0), watch: null }, at(1), false)).toEqual([]);
  });

  it("names CRON_SECRET as the likely cause of a watch that stopped", () => {
    const [row] = workerProblems({ beat: beat(0), watch: null }, at(1), true);
    expect(row.detail).toContain("CRON_SECRET");
  });
});

describe("workerAlertMessage", () => {
  const url = "https://app.getseopen.com/admin/health";

  it("says when the worker was last heard from and where to look", () => {
    const m = workerAlertMessage({ kind: "down", lastBeat: beat(0), watchingSince: at(-60).toISOString(), now: at(12), url });
    expect(m.subject).toBe("SEOpen: the worker has stopped, no heartbeat for 12 minutes");
    expect(m.text).toContain("2026-11-16 05:40 UTC");
    expect(m.text).toContain("worker's logs");
    expect(m.text).toContain(url);
    expect(m.html).not.toContain("<script");
  });

  it("says a worker that never started is failing at startup", () => {
    const m = workerAlertMessage({ kind: "down", lastBeat: null, watchingSince: at(0).toISOString(), now: at(10), url });
    expect(m.subject).toBe("SEOpen: the worker hasn't started, no heartbeat yet");
    expect(m.text).toContain("failing at startup");
  });

  it("gives long outages in hours", () => {
    expect(workerAlertMessage({ kind: "down", lastBeat: beat(0), watchingSince: at(0).toISOString(), now: at(620), url }).subject).toBe("SEOpen: the worker has stopped, no heartbeat for 10.3 hours");
  });

  it("says when it's back and how long it was gone", () => {
    const m = workerAlertMessage({ kind: "up", beat: beat(600, { startedAt: at(599).toISOString() }), downSince: at(0).toISOString(), now: at(602), url });
    expect(m.subject).toBe("SEOpen: the worker is back");
    expect(m.text).toContain("running 28 job types since 2026-11-16 15:39 UTC");
    expect(m.text).toContain("10 hours");
    expect(m.text).toContain("aren't made up");
  });
});

describe("cronAuthorized", () => {
  it("takes only the exact bearer secret", () => {
    expect(cronAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(cronAuthorized("Bearer s3cre", "s3cret")).toBe(false);
    expect(cronAuthorized("s3cret", "s3cret")).toBe(false);
    expect(cronAuthorized(null, "s3cret")).toBe(false);
  });

  it("lets nothing through without a secret", () => {
    expect(cronAuthorized("Bearer ", "")).toBe(false);
    expect(cronAuthorized("Bearer undefined", undefined)).toBe(false);
  });
});
