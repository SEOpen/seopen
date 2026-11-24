import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { adminUrl, claimAlert, ownerAlertTarget } from "@/lib/billing/alerts";
import { isProductionDeploy } from "@/lib/deploy-env";
import { sendEmail } from "@/lib/email";
import { HEARTBEAT_EVERY_MINUTES, WORKER_HEARTBEAT_KEY, type WorkerHeartbeat } from "./heartbeat";

/**
 * The web app's watch on the worker's heartbeat (src/lib/jobs/heartbeat.ts). The worker can't report
 * its own death, and a host can show a crash-looping worker as running, so the check runs in the web app.
 *
 * - `/api/cron/worker-watch`, called by a scheduler every WATCH_EVERY_MINUTES with `Bearer CRON_SECRET`,
 *   calls `checkWorker`. A beat
 *   older than WORKER_STALE_MINUTES means the worker is down: the owner gets one email per outage,
 *   then one more when a beat arrives again. Down at the latest WORKER_STALE_MINUTES plus one watch
 *   interval after the last beat, so a worker that throws at startup is reported in about 15 minutes.
 * - An outage is named by the last beat before it, so each gets its own claim, a `settings` row
 *   `platform.worker_alert:<last beat>:<down|up>` inserted with `on conflict do nothing`, as the
 *   balance and cap alerts do. With no beat ever (a new database, or a worker that never started
 *   after this shipped) the watch waits WORKER_STALE_MINUTES from its own first check before it calls
 *   the worker down, so a deploy that reaches the web app first doesn't alert.
 * - Without RESEND_API_KEY it logs and claims nothing, and tries again on the next check. A failed
 *   send gives the claim back and throws, so the cron's run shows as failed and the next one retries.
 * - What the watch last saw is the `platform.worker_watch` row. Admin → Health reads it and the beat
 *   (`workerProblems`), and in production also says when the watch itself has stopped running.
 */

/** A beat older than this means the worker is down: five missed beats, past any slow start or deploy overlap. */
export const WORKER_STALE_MINUTES = 10;
/** How often the Vercel cron checks (vercel.json). */
export const WATCH_EVERY_MINUTES = 5;
/** Health says the watch has stopped when it hasn't checked for this long. */
export const WATCH_STALE_MINUTES = 20;

export const WORKER_WATCH_KEY = "platform.worker_watch";
export type WorkerAlertKind = "down" | "up";
export const workerAlertKey = (outage: string, kind: WorkerAlertKind) => `platform.worker_alert:${outage}:${kind}`;

export interface WorkerWatch {
  checkedAt: string;
  /** The watch's first check on this database, which a missing beat is timed from. */
  firstCheckedAt: string;
  /** The outage it's in, named by the last beat before it; null while the worker is up. */
  down: { since: string; detectedAt: string; emailed: boolean } | null;
}

export type WorkerStatus =
  | { state: "up"; lastBeatAt: string; startedAt: string; jobs: number }
  | { state: "down"; lastBeatAt: string | null; minutes: number | null }
  /** No beat yet, and the watch hasn't waited long enough to call that an outage. */
  | { state: "waiting" };

const MINUTE = 60_000;
const ago = (iso: string, now: Date) => Math.floor((now.getTime() - new Date(iso).getTime()) / MINUTE);

/** Pure: the worker's state from its last beat, or from when the watch started looking when there's none. */
export function workerStatus(beat: WorkerHeartbeat | null, firstCheckedAt: string | null, now: Date): WorkerStatus {
  if (beat) {
    const minutes = ago(beat.at, now);
    return minutes < WORKER_STALE_MINUTES ? { state: "up", lastBeatAt: beat.at, startedAt: beat.startedAt, jobs: beat.jobs } : { state: "down", lastBeatAt: beat.at, minutes };
  }
  if (firstCheckedAt && ago(firstCheckedAt, now) >= WORKER_STALE_MINUTES) return { state: "down", lastBeatAt: null, minutes: null };
  return { state: "waiting" };
}

/** "2026-11-16 05:45 UTC": the worker and the web app run in different zones, so emails say UTC. */
const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const minutesText = (n: number) => (n === 1 ? "1 minute" : `${n} minutes`);
const span = (fromIso: string, to: Date) => {
  const m = Math.max(0, ago(fromIso, to));
  return m < 120 ? minutesText(m) : `${Math.round((m / 60) * 10) / 10} hours`;
};

const STOPS =
  "While it's down no background work runs: scheduled site audits, rank checks, Local SEO checks, AI visibility runs, Search Console and Analytics syncs, backlinks snapshots, fix checks, alert emails, the weekly recap and billing's daily checks. Jobs the app queues wait for it; cron runs it misses aren't made up when it's back.";
const LOOK =
  "Look at the worker's logs on your host. A host can show the worker as running while the process crash-loops at startup, so trust the logs, not the status.";

export type WorkerAlert =
  | { kind: "down"; lastBeat: WorkerHeartbeat | null; watchingSince: string; now: Date; url: string }
  | { kind: "up"; beat: WorkerHeartbeat; downSince: string | null; now: Date; url: string };

/** Pure: the email for one alert. */
export function workerAlertMessage(a: WorkerAlert) {
  let subject: string;
  let paragraphs: string[];
  if (a.kind === "down") {
    const first = a.lastBeat
      ? `The worker's last heartbeat was at ${utc(a.lastBeat.at)}, ${span(a.lastBeat.at, a.now)} ago. It writes one every ${HEARTBEAT_EVERY_MINUTES} minutes while it runs, so it has stopped, hung or can't reach the database.`
      : `No heartbeat has arrived from the worker since this watch began at ${utc(a.watchingSince)}. It writes one as soon as it has started and every ${HEARTBEAT_EVERY_MINUTES} minutes after, so it's failing at startup or isn't deployed.`;
    subject = a.lastBeat ? `SEOpen: the worker has stopped, no heartbeat for ${span(a.lastBeat.at, a.now)}` : "SEOpen: the worker hasn't started, no heartbeat yet";
    paragraphs = [first, STOPS, LOOK, `Admin → Health shows it until a heartbeat arrives: ${a.url}`, "This alert goes once per outage, and another email says when the worker is back."];
  } else {
    const gap = a.downSince ? ` There was no heartbeat from ${utc(a.downSince)} until then, ${span(a.downSince, new Date(a.beat.at))}.` : "";
    subject = "SEOpen: the worker is back";
    paragraphs = [
      `The worker wrote a heartbeat at ${utc(a.beat.at)}, running ${a.beat.jobs} job types since ${utc(a.beat.startedAt)}.${gap}`,
      "Cron runs it missed while it was down aren't made up: check what was due in that gap on Admin → Health and re-queue what matters.",
      a.url,
    ];
  }
  return { subject, text: paragraphs.join("\n\n"), html: paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") };
}

export interface WorkerProblem {
  problem: string;
  detail: string;
  at: string | null;
}

/**
 * Pure: Health's rows. The worker down or never seen, and, where a Vercel cron should be running the
 * watch (`expectWatch`, production on Vercel), a watch that hasn't checked lately: then nothing would
 * email, most likely because CRON_SECRET isn't set.
 */
export function workerProblems(state: { beat: WorkerHeartbeat | null; watch: WorkerWatch | null }, now: Date, expectWatch: boolean): WorkerProblem[] {
  const { beat, watch } = state;
  const out: WorkerProblem[] = [];
  if (!beat) {
    out.push({ problem: "No heartbeat", detail: `The worker has never written a heartbeat to this database, so it isn't running or fails at startup. ${LOOK}`, at: watch?.firstCheckedAt ?? null });
  } else if (workerStatus(beat, null, now).state === "down") {
    out.push({
      problem: "Down",
      detail: `No heartbeat for ${span(beat.at, now)} (one is due every ${HEARTBEAT_EVERY_MINUTES} minutes), so no background job is running. ${LOOK}`,
      at: beat.at,
    });
  }
  if (expectWatch && (!watch || ago(watch.checkedAt, now) >= WATCH_STALE_MINUTES)) {
    out.push({
      problem: "Watch not running",
      detail: `The Vercel cron that emails the owner when the worker stops (/api/cron/worker-watch, every ${WATCH_EVERY_MINUTES} minutes) ${watch ? `last checked ${span(watch.checkedAt, now)} ago` : "has never checked"}. Check that CRON_SECRET is set in Vercel production, then redeploy.`,
      at: watch?.checkedAt ?? null,
    });
  }
  return out;
}

/** The last beat and what the watch last saw, from `settings`. */
export async function readWorkerState(): Promise<{ beat: WorkerHeartbeat | null; watch: WorkerWatch | null }> {
  const rows = await db.select().from(settings).where(inArray(settings.key, [WORKER_HEARTBEAT_KEY, WORKER_WATCH_KEY]));
  const value = (key: string) => rows.find((r) => r.key === key)?.value ?? null;
  return { beat: value(WORKER_HEARTBEAT_KEY) as WorkerHeartbeat | null, watch: value(WORKER_WATCH_KEY) as WorkerWatch | null };
}

/** Health's worker rows, read live. */
export async function workerHealth(now = new Date()): Promise<WorkerProblem[]> {
  return workerProblems(await readWorkerState(), now, isProductionDeploy());
}

async function saveWatch(value: WorkerWatch) {
  await db.insert(settings).values({ key: WORKER_WATCH_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Claims the alert and sends it. "sent", "claimed" when another check sent it already, or "off"
 * when Resend or an alert address isn't set up here. A failed send gives the claim back and throws.
 */
async function sendWorkerAlert(key: string, alert: WorkerAlert): Promise<"sent" | "claimed" | "off"> {
  const message = workerAlertMessage(alert);
  const target = ownerAlertTarget();
  if ("off" in target) {
    console.warn(`[worker-watch] ${message.subject}: not emailed, ${target.off}`);
    return "off";
  }
  if (!(await claimAlert(key))) return "claimed";
  console.warn(`[worker-watch] ${message.subject}`);
  try {
    await sendEmail({ to: target.to, ...message });
  } catch (err) {
    await db.delete(settings).where(eq(settings.key, key));
    throw err;
  }
  return "sent";
}

export interface WatchResult {
  state: WorkerStatus["state"];
  /** The email this check sent, if any. */
  emailed: WorkerAlertKind | null;
}

/**
 * One watch check, from the Vercel cron: reads the beat, emails the owner when the worker has gone
 * down or come back, and records what it saw. Throws when a send failed, after saving the state, so
 * the next check sends it again.
 */
export async function checkWorker(now = new Date()): Promise<WatchResult> {
  const { beat, watch } = await readWorkerState();
  const firstCheckedAt = watch?.firstCheckedAt ?? now.toISOString();
  const status = workerStatus(beat, firstCheckedAt, now);
  let down = watch?.down ?? null;
  let emailed: WorkerAlertKind | null = null;
  let failure: unknown = null;
  const url = adminUrl("/admin/health");

  try {
    if (status.state === "down") {
      const since = beat?.at ?? `never:${firstCheckedAt}`;
      if (down?.since !== since) down = { since, detectedAt: now.toISOString(), emailed: false };
      if (!down.emailed) {
        const sent = await sendWorkerAlert(workerAlertKey(since, "down"), { kind: "down", lastBeat: beat, watchingSince: firstCheckedAt, now, url });
        down = { ...down, emailed: sent !== "off" };
        if (sent === "sent") emailed = "down";
      }
    } else if (status.state === "up" && down) {
      // Only an outage the owner heard about gets a recovery email.
      if (down.emailed) {
        const sent = await sendWorkerAlert(workerAlertKey(down.since, "up"), { kind: "up", beat: beat!, downSince: down.since.startsWith("never:") ? null : down.since, now, url });
        if (sent === "sent") emailed = "up";
      }
      down = null;
    }
  } catch (err) {
    failure = err;
  }

  await saveWatch({ checkedAt: now.toISOString(), firstCheckedAt, down });
  if (failure) throw failure;
  return { state: status.state, emailed };
}
