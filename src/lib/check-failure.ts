import type { ChangeDelta } from "@/components/ui/what-changed";
import { rules } from "@/plan-policy/rules";
import type { Refusal } from "./billing/errors";
import { formatShortDate } from "./format";

/**
 * A source whose newest check failed, or whose connection needs doing again. `ModuleResult.failed` only
 * means a loader threw, so this is how a failed job reaches Overview and All projects. Pure, so a page can
 * read it from stored rows and a test from anything.
 */
export interface CheckFailure {
  /** `stopped`: the source syncs fine, but its newest data is weeks behind what it asked for (see DATA_STOPPED_DAYS). */
  kind: "failed" | "reconnect" | "stopped";
  /** What ran, for the words: "Last check failed". */
  noun: "check" | "run" | "crawl" | "sync";
  /** When it failed, ISO. Null when nothing ran, which is a connection to redo. */
  at: string | null;
  /** The day of `at` in the workspace's zone: "Nov 7". */
  day: string | null;
  /** Why, in the customer's words. Never the vendor's text. */
  reason: string;
  /** Whether the check's own button could work, so a page can point at it. */
  retry: boolean;
  /** Where to go from a summary page. `label` "View" reads with the module's name beside it. */
  next: { label: string; href: string };
  /** The newest day with data, when `kind` is "stopped": "Oct 1". `day` is then the day it last synced. */
  since?: string;
  /** Who to reconnect, when `kind` is "reconnect". */
  provider?: "Google" | "PostHog" | "Plausible" | "Umami";
  /**
   * The check never got its searches out, past the hour. A lost job or a worker backlog can both do
   * that, so it's said as "didn't start" and quietly, never as a loud failure. A refused job closes its
   * row with the refusal instead, which is a real reason.
   */
  stuck?: boolean;
  /** Why the check's own button would refuse right now, in the refusal's words. `retry` is false with it. */
  blocked?: string;
}

/** A check row still "posting" after this long lost its job (worker died, enqueue failed). The next poll or check closes it. */
export const STALE_POSTING_MS = 60 * 60_000;

/** The stored reason for a check closed by that rule, or an AI run whose job was lost. */
export const POSTING_NEVER_FINISHED = "Posting never finished";

export interface CheckRow {
  status: string;
  error: string | null;
  createdAt: Date;
  finishedAt?: Date | null;
}

/** Whether a check row is stuck posting, past the point where the next check closes it. A younger one is simply running. */
export function isStalePosting(row: Pick<CheckRow, "status" | "createdAt">, now = new Date()): boolean {
  return row.status === "posting" && now.getTime() - row.createdAt.getTime() > STALE_POSTING_MS;
}

/**
 * Whether a project's or a business's newest check row has failed. Only the newest counts, so a later
 * success clears an older failure and a check in flight isn't one. `stalePosting` is for the tables with
 * that rule: rank and Local. An AI or audit row waiting on a job stays a check in flight, because nothing
 * there says it's stuck.
 */
export function newestFailed(newest: CheckRow | undefined, { stalePosting = false, now = new Date() }: { stalePosting?: boolean; now?: Date } = {}): { stuck?: boolean; at: Date; stored: string | null } | null {
  if (!newest) return null;
  if (newest.status === "failed") return { at: newest.finishedAt ?? newest.createdAt, stored: newest.error, stuck: newest.error === POSTING_NEVER_FINISHED };
  if (stalePosting && isStalePosting(newest, now)) return { at: newest.createdAt, stored: POSTING_NEVER_FINISHED, stuck: true };
  return null;
}

/** A failed check as the summary pages read it. */
export function failedCheck(f: { noun: CheckFailure["noun"]; at: Date; timeZone: string; reason: string; retry: boolean; next: CheckFailure["next"]; stuck?: boolean }): CheckFailure {
  const reason = /[.!?]$/.test(f.reason) ? f.reason : `${f.reason}.`;
  return { kind: "failed", noun: f.noun, at: f.at.toISOString(), day: formatShortDate(f.at, f.timeZone), reason, retry: f.retry, next: f.next, ...(f.stuck ? { stuck: true } : {}) };
}

/**
 * An Analytics source whose newest day with data is this many days or more behind the last day its sync asked
 * for has stopped sending data, however well the sync runs. GA4 lags a day or two, and the sync's checked-through
 * day already allows for that, so the gap is days with nothing at all. A small site can go a week without a search
 * visit, so two weeks of nothing is past both.
 */
export const DATA_STOPPED_DAYS = 14;

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** Whether a sync that asked through `checkedThrough` ("YYYY-MM-DD") with `newest` its newest day of data has stopped getting any. Pure. */
export function dataStopped(checkedThrough: string | null | undefined, newest: string | null | undefined): boolean {
  if (!checkedThrough || !newest) return false;
  return dayNumber(checkedThrough) - dayNumber(newest) >= DATA_STOPPED_DAYS;
}

const shortDay = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A source that synced at `at` with nothing newer than `since` ("YYYY-MM-DD"). Running the sync again can't bring data the source isn't sending. */
export function stoppedData(f: { at: Date; timeZone: string; since: string; reason: string; next: CheckFailure["next"] }): CheckFailure {
  return { kind: "stopped", noun: "sync", at: f.at.toISOString(), day: formatShortDate(f.at, f.timeZone), since: shortDay(f.since), reason: f.reason, retry: false, next: f.next };
}

/** A change measured over a window that ended weeks ago is neither good nor bad news, so it loses its colour and its "(better)". */
export function withoutTone(delta: ChangeDelta | null, failure: CheckFailure | null | undefined): ChangeDelta | null {
  return delta && failure?.kind === "stopped" ? { ...delta, tone: "muted" } : delta;
}

/** What became of the last try: "Last check failed", "Last check didn't start". A callout's title goes on from this. */
export const lastTry = (f: Pick<CheckFailure, "noun" | "stuck"> & Partial<Pick<CheckFailure, "kind" | "since">>): string =>
  f.kind === "stopped" ? `No data since ${f.since}` : `Last ${f.noun} ${f.stuck ? "didn't start" : "failed"}`;

/** The sentence over a module with no results at all. */
export const noResultsBecause = (f: Pick<CheckFailure, "noun" | "stuck"> & Partial<Pick<CheckFailure, "kind" | "since">>): string =>
  f.kind === "stopped" ? `No results since ${f.since}.` : `No results yet, because the last ${f.noun} ${f.stuck ? "didn't start" : "failed"}.`;

/** How loud a figure or a row says it. A check that didn't start may only be behind, so it isn't red. */
export const failureTone = (f: CheckFailure): "bad" | undefined => (f.stuck ? undefined : "bad");

/** Advice to run the same thing again, for where that isn't on offer. "Running it again won't help" stays. */
export const withoutRetryAdvice = (reason: string): string => reason.replace(/\s*(Run it again|Start a new one)[^.]*\.$/, "");

/** Billing can't lift these: a suspended workspace, an unconfirmed email, SEOpen's own pause, the owner's cap in Admin. */
const BILLING_CANT_HELP = /suspended|confirm your email|SEOpen has paused|Admin/i;

/** The way forward from a refusal, when Billing is one. */
export const refusalFix = (message: string): CheckFailure["next"] | null =>
  !rules.plansHref || BILLING_CANT_HELP.test(message) ? null : { label: "Open Billing", href: rules.plansHref };

/** Refusals that mean the plan or a read-only project rules this check out, so no newer run can clear the failure. */
const RULED_OUT: ReadonlySet<Refusal["code"]> = new Set(["free_plan", "no_plan", "locked"]);

/**
 * A failed check as a module's own page says it: the failure stands, and when the check's button would
 * refuse right now it says why instead of offering it.
 */
export function pageFailure(f: CheckFailure | null, refusal: Pick<Refusal, "message"> | null | undefined): CheckFailure | null {
  if (!f || !refusal) return f;
  const said = f.reason === refusal.message;
  return { ...f, retry: false, reason: said ? f.reason : withoutRetryAdvice(f.reason), ...(said ? {} : { blocked: refusal.message }), next: refusalFix(refusal.message) ?? f.next };
}

/** The same for Overview and All projects, where a check the plan rules out raises no alarm: nothing newer can ever clear it. */
export function summaryFailure(f: CheckFailure | null, refusal: Pick<Refusal, "code" | "message"> | null | undefined): CheckFailure | null {
  return refusal && RULED_OUT.has(refusal.code) ? null : pageFailure(f, refusal);
}

/** What a callout says after the reason: the button's offer when it would work, else why it wouldn't. */
export const failureAgain = (f: CheckFailure, again: string | null): string | null => (f.retry ? again : (f.blocked ?? null));

/** Where a callout links, if the way forward is another page. "View" is the module the callout is already on. */
export const failureLink = (f: CheckFailure): CheckFailure["next"] | null => (f.retry || f.next.label === "View" ? null : f.next);

/** A "Needs a look" row. A check that didn't start has no more to say than its first words, unless the button is refused. */
export function failureLine(f: CheckFailure): string {
  const words = `${failureWords(f)}.`;
  return [words, f.stuck ? null : f.reason, f.blocked].filter(Boolean).join(" ");
}

/** Whether a check's own button is the page's main action: before any results, unless the newest failed in a way running another can't fix. */
export function checkIsMainAction(hasResults: boolean, failure: Pick<CheckFailure, "retry"> | null | undefined): boolean {
  return !hasResults && (failure?.retry ?? true);
}

/** A figure's or a row's words when there's no number to show: "Last check failed Nov 7", "Reconnect Google", "No data since Oct 1". */
export function failureWords(f: CheckFailure): string {
  if (f.kind === "stopped") return lastTry(f);
  return f.kind === "reconnect" ? `Reconnect ${f.provider}` : `${lastTry(f)} ${f.day}`;
}

/** The same beside a number that is older than that: "last check failed Nov 7", "reconnect Google to update", "synced Nov 6 with nothing newer". */
export function failureAside(f: CheckFailure): string {
  if (f.kind === "stopped") return `synced ${f.day} with nothing newer`;
  return f.kind === "reconnect" ? `reconnect ${f.provider} to update` : `${lastTry(f).toLowerCase()} ${f.day}`;
}

/** A module's line once a newer check failed, so "last check Nov 5" can't read as the newest: "a newer check failed Nov 7". */
export function newerFailed(f: CheckFailure): string {
  return f.kind === "failed" ? `a newer ${f.noun} ${f.stuck ? "didn't start" : "failed"} ${f.day}` : failureAside(f);
}

/** A figure's caption when its number is older than the source's last try. `from`: the day the number is from, when the caption doesn't say. */
export function staleCaption(caption: string | undefined, f: CheckFailure, from?: string | null): string {
  const aside = failureAside(f);
  const note = from && !caption?.includes(from) ? `From ${from}, ${aside}.` : `${aside.charAt(0).toUpperCase()}${aside.slice(1)}.`;
  return caption ? `${caption}. ${note}` : note;
}

/** What became of several sources' latest checks: all stuck is "didn't start", any mix "didn't finish". */
const latestChecks = (failed: LookingAt[]) => (failed.every((s) => s.failure.stuck) ? "didn't start" : failed.some((s) => s.failure.stuck) ? "didn't finish" : "failed");

/** The source names that read as plural. */
const PLURAL_LABELS: ReadonlySet<string> = new Set(["Rankings"]);

const list = (names: string[]) => new Intl.ListFormat("en-US", { type: "conjunction" }).format(names);

export interface LookingAt {
  label: string;
  failure: CheckFailure;
}

/**
 * The sentence over a project's failed or disconnected sources. One line says all of them: which, and,
 * with only one, when. The reasons are on the rows below it.
 */
export function needsLookSentence(sources: LookingAt[]): string {
  const failed = sources.filter((s) => s.failure.kind === "failed");
  const parts: string[] = [];
  if (failed.length === 1) {
    const [{ label, failure }] = failed;
    parts.push(`${label} ${PLURAL_LABELS.has(label) ? "need" : "needs"} a look: the last ${failure.noun} ${failure.stuck ? "didn't start" : "failed"} on ${failure.day}.`);
  } else if (failed.length) {
    parts.push(`${list(failed.map((s) => s.label))} need a look: their latest checks ${latestChecks(failed)}.`);
  }
  for (const provider of new Set(sources.flatMap((s) => (s.failure.kind === "reconnect" ? [s.failure.provider] : [])))) {
    const names = sources.filter((s) => s.failure.kind === "reconnect" && s.failure.provider === provider).map((s) => s.label);
    parts.push(`Reconnect ${provider} to update ${list(names)}.`);
  }
  for (const { label, failure } of sources) if (failure.kind === "stopped") parts.push(`${label} still syncs, but no data has arrived since ${failure.since}.`);
  return parts.join(" ");
}

/** The same as a clause, after a project's name: "the last Rankings check failed on Nov 7". */
export function needsLookClause(sources: LookingAt[]): string {
  const failed = sources.filter((s) => s.failure.kind === "failed");
  const providers = [...new Set(sources.flatMap((s) => (s.failure.kind === "reconnect" ? [s.failure.provider] : [])))];
  const parts: string[] = [];
  if (failed.length === 1) parts.push(`the last ${failed[0].label} ${failed[0].failure.noun} ${failed[0].failure.stuck ? "didn't start" : "failed"} on ${failed[0].failure.day}`);
  else if (failed.length) parts.push(`the latest checks ${latestChecks(failed)} for ${list(failed.map((s) => s.label))}`);
  if (providers.length) parts.push(`${list(providers.map(String))} ${providers.length === 1 ? "needs" : "need"} reconnecting`);
  for (const { label, failure } of sources) if (failure.kind === "stopped") parts.push(`no ${label} data has arrived since ${failure.since}`);
  return parts.join(", and ");
}
