import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The worker watch against seopen_test: the worker's beats, then the Vercel cron's checks, replayed
 * on a made-up clock far in the future. The send is stubbed, so nothing reaches Resend. The beat and
 * the watch are one row each for the whole platform, so each test starts with neither and the real
 * ones (if any) are put back afterwards.
 */

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string; html: string }[]);
const mail = vi.hoisted(() => ({ failing: false, configured: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  emailConfigured: () => mail.configured,
  sendEmail: async (msg: { to: string; subject: string; text: string; html: string }) => {
    if (mail.failing) throw new Error("Resend rejected the message");
    sent.push(msg);
  },
}));

/** Owner alerts need an address now that core has no default one. */
const ALERT_TO = "owner@example.com";
vi.stubEnv("OWNER_ALERT_EMAIL", ALERT_TO);

const ready = await testDb();

const { db } = await import("@/db");
const { settings } = await import("@/db/schema");
const { WORKER_HEARTBEAT_KEY, markWorkerStarted, writeHeartbeat } = await import("./heartbeat");
const { WORKER_WATCH_KEY, checkWorker, readWorkerState, workerAlertKey, workerProblems } = await import("./worker-watch");

const KEYS = [WORKER_HEARTBEAT_KEY, WORKER_WATCH_KEY];

/** A start time no real beat uses: year 2900 plus a random day, a new one for each test. */
let base = Date.UTC(2900, 0, 1) + Math.floor(Math.random() * 20_000) * 86_400_000;
const starts: string[] = [];
function newClock() {
  base += 86_400_000 * 3;
  const t0 = base;
  starts.push(new Date(t0).toISOString().slice(0, 10));
  return (minutes: number) => new Date(t0 + minutes * 60_000);
}

/** The worker: starts, then beats every 2 minutes from `from` to `to`. */
async function workerRuns(at: (m: number) => Date, from: number, to: number) {
  markWorkerStarted(28, at(from));
  for (let m = from; m <= to; m += 2) await writeHeartbeat(at(m));
}

/** Health's rows at a moment, as on production. */
async function health(now: Date) {
  return workerProblems(await readWorkerState(), now, true);
}

describe.skipIf(!ready)("the worker watch", () => {
  let saved: { key: string; value: unknown; updatedAt: Date }[] = [];

  beforeAll(async () => {
    saved = await db.select().from(settings).where(inArray(settings.key, KEYS));
  });

  beforeEach(async () => {
    sent.length = 0;
    mail.failing = false;
    mail.configured = true;
    await db.delete(settings).where(inArray(settings.key, KEYS));
  });

  afterAll(async () => {
    for (const day of starts) await db.delete(settings).where(like(settings.key, `platform.worker_alert:${day}%`));
    await db.delete(settings).where(like(settings.key, "platform.worker_alert:never:29%"));
    await db.delete(settings).where(inArray(settings.key, KEYS));
    if (saved.length) await db.insert(settings).values(saved);
  });

  it("emails the owner within 15 minutes when a deploy's worker throws at startup, and Health shows it", async () => {
    const at = newClock();
    // The old worker beats until the deploy stops it at minute 10; the new one throws before its first beat.
    await workerRuns(at, 0, 10);
    for (const m of [10, 15]) expect(await checkWorker(at(m))).toEqual({ state: "up", emailed: null });
    expect(await health(at(15))).toEqual([]);

    expect(await checkWorker(at(20))).toEqual({ state: "down", emailed: "down" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ALERT_TO);
    expect(sent[0].subject).toBe("SEOpen: the worker has stopped, no heartbeat for 10 minutes");
    expect(await health(at(20))).toEqual([expect.objectContaining({ problem: "Down", at: at(10).toISOString() })]);

    // One email per outage, however long it lasts.
    for (const m of [25, 30, 300]) expect(await checkWorker(at(m))).toEqual({ state: "down", emailed: null });
    expect(sent).toHaveLength(1);
  });

  it("emails once more when the worker is back, and Health clears", async () => {
    const at = newClock();
    await workerRuns(at, 0, 0);
    await checkWorker(at(15));
    expect(sent.map((m) => m.subject)).toEqual(["SEOpen: the worker has stopped, no heartbeat for 15 minutes"]);

    await workerRuns(at, 600, 600);
    expect(await checkWorker(at(602))).toEqual({ state: "up", emailed: "up" });
    expect(sent.at(-1)!.subject).toBe("SEOpen: the worker is back");
    expect(sent.at(-1)!.text).toContain("10 hours");
    expect(await health(at(602))).toEqual([]);
    expect(await checkWorker(at(607))).toEqual({ state: "up", emailed: null });
    expect(sent).toHaveLength(2);

    // Down again later is a new outage, with its own email.
    expect(await checkWorker(at(611))).toEqual({ state: "down", emailed: "down" });
    expect(sent).toHaveLength(3);
  });

  it("waits out a deploy that reaches Vercel before the worker, then calls a worker that never beat down", async () => {
    const at = newClock();
    expect(await checkWorker(at(0))).toEqual({ state: "waiting", emailed: null });
    expect(await checkWorker(at(5))).toEqual({ state: "waiting", emailed: null });
    expect(sent).toEqual([]);
    expect(await checkWorker(at(10))).toEqual({ state: "down", emailed: "down" });
    expect(sent[0].subject).toBe("SEOpen: the worker hasn't started, no heartbeat yet");
    expect(await health(at(10))).toEqual([expect.objectContaining({ problem: "No heartbeat" })]);

    await workerRuns(at, 12, 12);
    expect(await checkWorker(at(15))).toEqual({ state: "up", emailed: "up" });
    expect(sent).toHaveLength(2);
  });

  it("records the start and the job count in each beat", async () => {
    const at = newClock();
    await workerRuns(at, 0, 4);
    expect((await readWorkerState()).beat).toEqual({ at: at(4).toISOString(), startedAt: at(0).toISOString(), jobs: 28 });
  });

  it("gives a failed send's claim back and sends on the next check", async () => {
    const at = newClock();
    await workerRuns(at, 0, 0);
    mail.failing = true;
    await expect(checkWorker(at(10))).rejects.toThrow("Resend rejected the message");
    expect(await db.select().from(settings).where(inArray(settings.key, [workerAlertKey(at(0).toISOString(), "down")]))).toEqual([]);
    // Health still shows it, and the watch counts as running: it saved what it saw.
    expect(await health(at(10))).toEqual([expect.objectContaining({ problem: "Down" })]);

    mail.failing = false;
    expect(await checkWorker(at(15))).toEqual({ state: "down", emailed: "down" });
    expect(sent).toHaveLength(1);
  });

  it("claims nothing without Resend, and emails once it's set up", async () => {
    const at = newClock();
    await workerRuns(at, 0, 0);
    mail.configured = false;
    expect(await checkWorker(at(10))).toEqual({ state: "down", emailed: null });
    mail.configured = true;
    expect(await checkWorker(at(15))).toEqual({ state: "down", emailed: "down" });
    expect(sent).toHaveLength(1);
  });

  it("sends an outage's email once when two checks race", async () => {
    const at = newClock();
    await workerRuns(at, 0, 0);
    await Promise.all([checkWorker(at(10)), checkWorker(at(10))]);
    expect(sent).toHaveLength(1);
  });
});
