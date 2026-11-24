import type { FigureData } from "@/components/ui/figure";
import { chartDay } from "@/components/ui/module-card";
import { pickHighlights, type ChangeRow } from "@/components/ui/what-changed";
import { changeDelta, countDelta, countDeltaFromZero, joiner } from "@/lib/brief";
import { rules } from "@/plan-policy/rules";
import { failureAside, failureTone, failureWords, needsLookSentence, staleCaption, withoutTone } from "@/lib/check-failure";
import { formatNumber } from "@/lib/format";
import { zonedJobTime } from "@/lib/schedule";
import { AI_NOT_ON_FREE } from "@/modules/ai/brief";
import type { AiDashboardData } from "@/modules/ai/dashboard";
import type { AuditDashboardData } from "@/modules/audit/dashboard";
import type { BacklinksDashboardData } from "@/modules/backlinks/dashboard";
import type { GoogleDashboardData } from "@/modules/google/dashboard";
import type { Ga4DashboardData } from "@/modules/google/ga4-dashboard";
import { addDays, daysBetween, storedDays, todayIn } from "@/modules/google/windowing";
import type { LocalDashboardData } from "@/modules/local/dashboard";
import { FIRST_CHECK_RUNNING, NOT_ON_FREE, positionNote } from "@/modules/rank/brief";
import type { RankDashboardData } from "@/modules/rank/dashboard";
import type { ModuleResult } from "./dashboard-load";
import { citedDelta, dataDay, needsLook, pageOneDelta, pageOneNotConfirmed, projectMoves, projectSentence, withoutFailing, type ProjectMove } from "./project-summary";

const PLANS_HREF = rules.plansHref ?? "/";
const ON_STARTER = rules.notIncludedLabel;

/** Modules the figures and the "What changed" rows read. Their "not set up" states are said there. */
export const HEADLINE_MODULES: ReadonlySet<string> = new Set(["google", "rank", "ai", "audit"]);

/** Changes the fixed rows already show, so "Also moved" doesn't repeat them. */
const SHOWN_IN_ROWS: ReadonlySet<string> = new Set(["google:Clicks", "rank:Tracked position"]);

const WEEK = 7;

/**
 * Clicks over the latest 7 days of stored data against the 7 before, from the card's daily series.
 * A day missing from the series had no impressions, so it counts as zero, but only once stored
 * history is known to reach it: `days` is short of 7, and `previous` null, on a new property.
 */
export function clicksThisWeek(d: GoogleDashboardData): { days: number; current: number; previous: number | null } {
  const historyKnown = d.previous != null;
  const first = d.series[0]?.date;
  const covered = (date: string) => historyKnown || (first != null && first <= date);
  const sum = (from: string, to: string) => d.series.reduce((n, p) => (p.date >= from && p.date <= to ? n + p.clicks : n), 0);
  const weekStart = addDays(d.end, -(WEEK - 1));
  const before = addDays(weekStart, -WEEK);
  const days = covered(weekStart) ? WEEK : first ? daysBetween(first, d.end) + 1 : 0;
  return { days, current: sum(weekStart, d.end), previous: covered(before) ? sum(before, addDays(weekStart, -1)) : null };
}

/** "8 keywords tracked, waiting…" as the start of a sentence. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;

const failedText = (slow: boolean) => (slow ? "Took too long to load" : "Couldn't load");

export interface Headlines {
  /** What changed across the project, in a sentence. */
  sentence: string;
  /** The strip at the top of the page: one number per module, or why it has none. */
  figures: FigureData[];
  /** The fixed rows: always these, in this order, each with a value or the reason it has none. */
  rows: ChangeRow[];
  /** Anything else that moved, worse first, across every module. */
  also: ChangeRow[];
}

/**
 * Turns the dashboard loaders' results into the top of a project's Overview. Pure, so every state can be
 * previewed at /dev/cards and tested. `gscConnected`: the project has a Search Console property, which
 * tells "not connected" from "connected, nothing synced yet". `free`: the Free plan has no rank tracking
 * or AI prompts, so where they'd offer to add some, they say they're on Starter instead.
 */
export function buildHeadlines(results: ModuleResult[], { gscConnected, free = false }: { gscConnected: boolean; free?: boolean }): Headlines {
  const of = (id: string) => results.find((r) => r.module.id === id);
  const position = positionFigure(of("rank"), of("google"), free);
  return {
    sentence: overviewSentence(results),
    figures: [
      figureAfterLastRun(clicksFigure(of("google"), gscConnected), of("google")),
      // With no tracked number this one is Search Console's, so that's whose failure it carries.
      figureAfterLastRun(position, position.label === "Tracked position" ? of("rank") : of("google")),
      figureAfterLastRun(pageOneFigure(of("rank"), free), of("rank")),
      figureAfterLastRun(citedFigure(of("ai"), free), of("ai")),
      figureAfterLastRun(healthFigure(of("audit")), of("audit")),
    ],
    rows: [rowAfterLastRun(clicksRow(of("google"), gscConnected), of("google")), rowAfterLastRun(positionRow(of("rank"), free), of("rank")), rowAfterLastRun(citedRow(of("ai"), free), of("ai")), rowAfterLastRun(errorsRow(of("audit")), of("audit"))],
    also: alsoMoved(results),
  };
}

/** The moves the strip under the sentence shows. AI visibility goes with them: it's the other half of "AI citing you". */
const READOUT_MOVES: ReadonlySet<string> = new Set(["clicks", "page-one", "cited", "ai-visibility", "health"]);

const AI_MOVES: ReadonlySet<string> = new Set(["cited", "ai-visibility"]);

const isIn = (ids: ReadonlySet<string>, m: ProjectMove) => !!m.id && ids.has(m.id);

/** What the clause compares against, when it says so at its end. */
const AGAINST = / (?:since|on the|compared with) .+$/;

/** Two moves as one sentence, saying what they compare against once when they share it. */
function joinMoves(first: ProjectMove, second?: ProjectMove): string {
  if (!second) return `${sentence(first.clause)}.`;
  const against = first.clause.match(AGAINST)?.[0];
  const lead = against && second.clause.endsWith(against) ? first.clause.slice(0, -against.length) : first.clause;
  return `${sentence(lead)}, ${joiner(first, second)} ${second.clause}.`;
}

/**
 * The sentence over this project's readouts. A source whose newest check failed comes first, with what the
 * healthy ones moved after it. Otherwise it leads with a number the strip shows, worst first, and only
 * falls back to the sentence every project gets when none of those moved. A fall still gets said wherever it
 * is, and AI visibility and citing are said together when they part ways, since either alone would mislead.
 */
export function overviewSentence(results: ModuleResult[]): string {
  const looking = needsLook(results);
  if (!looking.length) return movesSentence(results) ?? projectSentence(results);
  const moved = movesSentence(withoutFailing(results));
  return moved ? `${needsLookSentence(looking)} ${moved}` : projectSentence(results);
}

function movesSentence(results: ModuleResult[]): string | null {
  const solid = projectMoves(results)
    .filter((m) => m.solid)
    .sort((a, b) => b.weight - a.weight);
  const shown = solid.filter((m) => isIn(READOUT_MOVES, m));
  // A neutral move, like a gain no look confirmed, never leads over one a check confirmed.
  const first = shown.find((m) => m.tone === "bad") ?? shown.find((m) => m.tone === "good") ?? shown[0];
  if (!first) return null;
  const counterpart = (m: ProjectMove) => (isIn(AI_MOVES, m) ? shown.find((o) => isIn(AI_MOVES, o) && o.tone !== m.tone) : undefined);
  const opposite = (pool: ProjectMove[]) => pool.find((m) => m.tone !== first.tone && m.tone !== "neutral" && !counterpart(m));
  const rest = solid.filter((m) => !shown.includes(m));
  return joinMoves(first, counterpart(first) ?? opposite(shown) ?? opposite(rest) ?? shown.find((m) => m !== first && !counterpart(m)));
}

/**
 * The Overview's notice when modules are set up but nothing has results yet. A paid plan's checks are
 * on their way; Free runs none of them, so it names them and says what Free covers.
 */
export function waitingEmpty(name: string, { free, modules, time }: { free: boolean; /** Labels of the modules waiting. */ modules: string[]; time: string }): { title: string; description: string } {
  if (!free) {
    return {
      title: `${name} is set up and waiting for its first results`,
      description: `Numbers appear here as the first checks finish. Rankings are checked every day at ${time} and AI visibility asks its prompts every week; Check now on either page runs one sooner.`,
    };
  }
  const list = modules.length > 1 ? `${modules.slice(0, -1).join(", ")} or ${modules.at(-1)}` : modules[0];
  return {
    title: `Nothing to show for ${name} yet`,
    description: `The Free plan doesn't check ${list}, so no results are on their way. Choose a plan on the Billing page to start them, or begin with what Free covers: a site audit and Search Console.`,
  };
}

/**
 * How each module's data was last brought up to date, and what runs next, to end the page on. Null with nothing loaded.
 * `free`: the Free plan runs only the audit, so older Rankings, Local SEO, AI and Backlinks data gets no next run.
 */
export function finishLine(results: ModuleResult[], timeZone: string, now?: Date, free = false): string | null {
  const data = <D,>(id: string) => {
    const r = results.find((x) => x.module.id === id);
    return r?.status === "ok" ? (r.data as D) : null;
  };
  const google = data<GoogleDashboardData>("google");
  const ga4 = data<Ga4DashboardData>("ga4");
  const rank = data<RankDashboardData>("rank");
  const ai = data<AiDashboardData>("ai");
  const audit = data<AuditDashboardData>("audit");
  const backlinks = data<BacklinksDashboardData>("backlinks");
  const local = data<LocalDashboardData>("local");
  // What's next, unless the newest try failed: then that's what follows the date.
  const after = (id: string, next = "") => {
    const failure = results.find((x) => x.module.id === id)?.lastRunFailed;
    return failure ? `, ${failureAside(failure)}` : next;
  };
  // The tracker can be turned off, the re-crawl is opt-in and a listing's check can be paused, so these promise a next run only when one is coming.
  const parts = [
    google && `Search Console data to ${chartDay(google.end)}${after("google")}`,
    ga4 && `Analytics data to ${chartDay(ga4.end)}${after("ga4")}`,
    rank && `Rankings checked ${chartDay(rank.latest.date)}${after("rank", rank.enabled && !free ? `, then daily at ${zonedJobTime("06:00", timeZone, now)}` : "")}`,
    local && `Local SEO checked ${chartDay(todayIn(local.timeZone, new Date(local.latest.at)))}${after("local", local.weekly && !free ? ", then weekly" : "")}`,
    ai && `AI answers from ${chartDay(todayIn(ai.timeZone, new Date(ai.lastRunAt)))}${after("ai", free ? "" : ", then weekly")}`,
    audit?.latest && `Site crawled ${chartDay(todayIn(audit.timeZone, new Date(audit.latest.finishedAt)))}${after("audit", audit.weekly ? ", then weekly" : "")}`,
    backlinks && `Backlinks as of ${chartDay(backlinks.date)}${after("backlinks", free ? "" : ", then weekly")}`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(". ")}.` : null;
}

type Result = ModuleResult | undefined;

/** A figure once its source's newest check failed: a number says it's older than that; no number says the failure instead of a reason that isn't so. */
function figureAfterLastRun(figure: FigureData, r: Result): FigureData {
  const failure = r?.lastRunFailed;
  if (!failure || r?.status === "failed") return figure;
  if (figure.state === "value") return { ...figure, delta: withoutTone(figure.delta, failure), caption: staleCaption(figure.caption, failure, dataDay(r)) };
  const { id, label } = figure;
  const action = failure.next.label === "View" ? `View ${r?.module.label}` : failure.next.label;
  return { id, label, href: failure.next.href, state: "empty", text: failureWords(failure), tone: failureTone(failure), action: { label: action, href: failure.next.href } };
}

/** The same for a fixed row. */
function rowAfterLastRun(row: ChangeRow, r: Result): ChangeRow {
  const failure = r?.lastRunFailed;
  if (!failure || r?.status === "failed") return row;
  if (row.state === "value") return { ...row, delta: withoutTone(row.delta, failure), meta: row.meta ? `${row.meta} · ${failureAside(failure)}` : failureAside(failure) };
  const { key, label, source } = row;
  return { key, label, source, href: failure.next.href, state: "empty", text: failureWords(failure), tone: failureTone(failure), action: failure.next.label };
}

/**
 * The empty state of a fixed row: a reason from the module's status, leading where it can be fixed.
 * `onStarter`: the plan doesn't include the module, so setting it up leads to the plans instead.
 */
function emptyRow(
  base: Pick<ChangeRow, "key" | "label" | "source">,
  r: Result,
  when: { setup: string; action: string; waiting?: string; connected?: boolean; onStarter?: boolean },
): ChangeRow {
  const href = r?.module.href ?? "/";
  if (r?.status === "failed") return { ...base, href, state: "empty", text: failedText(r.slow), tone: "bad", action: "View" };
  if (r?.status === "empty" && r.waiting) return { ...base, href, state: "empty", text: when.waiting ?? sentence(r.waiting), action: "View" };
  if (when.onStarter) return { ...base, href: PLANS_HREF, state: "empty", text: ON_STARTER, action: "See plans" };
  return { ...base, href: r?.module.setup.href ?? href, state: "empty", text: when.setup, action: when.action };
}

function clicksRow(r: Result, connected: boolean): ChangeRow {
  const base = { key: "clicks", label: "Clicks", source: "Search Console" };
  if (r?.status !== "ok") {
    return emptyRow(base, r, connected ? { setup: "Nothing synced yet", action: "View" } : { setup: "Not connected", action: "Connect" });
  }
  const d = r.data as GoogleDashboardData;
  const week = clicksThisWeek(d);
  return {
    ...base,
    // The chart beside this reads 28 days by default, so the row says its shorter window in its name.
    label: `Clicks, last ${week.days === 1 ? "day" : `${week.days} days`}`,
    href: r.module.href,
    state: "value",
    meta: week.previous == null ? `to ${chartDay(d.end)}` : `to ${chartDay(d.end)}, vs the ${WEEK} before`,
    from: week.previous == null ? undefined : formatNumber(week.previous),
    to: formatNumber(week.current),
    delta: countDeltaFromZero(week.current, week.previous),
  };
}

/** The Tracked position row's words for keywords with no results yet. */
function firstCheckRow(r: Result): string {
  const waiting = r?.status === "empty" ? r.waiting : undefined;
  if (waiting?.endsWith(FIRST_CHECK_RUNNING)) return "First check running";
  if (waiting?.endsWith(NOT_ON_FREE)) return "Not on the Free plan";
  return "Waiting for first check";
}

function positionRow(r: Result, free: boolean): ChangeRow {
  const base = { key: "position", label: "Tracked position", source: "Rankings" };
  if (r?.status !== "ok") return emptyRow(base, r, { setup: "No tracked keywords", action: "Add keywords", waiting: firstCheckRow(r), onStarter: free });
  const d = r.data as RankDashboardData;
  const pos = d.latest.avgPosition;
  if (pos == null) return { ...base, href: r.module.href, state: "empty", text: "No keywords ranking yet", action: "View" };
  const prev = d.previous?.avgPosition;
  return {
    ...base,
    href: r.module.href,
    state: "value",
    meta: [prev == null ? "" : `vs ${chartDay(d.previous!.date)}`, positionNote(d.latest).slice(2)].filter(Boolean).join(", ") || undefined,
    from: prev?.toFixed(1),
    to: pos.toFixed(1),
    delta: prev == null ? null : changeDelta(pos - prev, "decimal", "down", true),
  };
}

const ofTotal = (t: Pick<AiDashboardData["current"], "cited" | "total">) => `${formatNumber(t.cited)} of ${formatNumber(t.total)}`;

function citedRow(r: Result, onFree: boolean): ChangeRow {
  const base = { key: "cited", label: "AI citing you", source: "AI visibility" };
  const free = r?.status === "empty" && !!r.waiting?.endsWith(AI_NOT_ON_FREE);
  if (r?.status !== "ok") return emptyRow(base, r, { setup: "No tracked prompts", action: "Add prompts", waiting: free ? "Not on the Free plan" : "Waiting for first run", onStarter: onFree });
  const d = r.data as AiDashboardData;
  const { current: cur, previous: prev } = d;
  return {
    ...base,
    href: r.module.href,
    state: "value",
    meta: prev ? "vs previous run" : undefined,
    // Prompts come and go, so the earlier total shows when it differs from the current one.
    from: prev ? (prev.total === cur.total ? formatNumber(prev.cited) : ofTotal(prev)) : undefined,
    to: ofTotal(cur),
    delta: citedDelta(d),
  };
}

function errorsRow(r: Result): ChangeRow {
  const base = { key: "errors", label: "Pages with errors", source: "Site audit" };
  if (r?.status !== "ok") return emptyRow(base, r, { setup: "No crawl yet", action: "Run a crawl" });
  const d = r.data as AuditDashboardData;
  if (!d.latest) return { ...base, href: r.module.href, state: "empty", text: "Crawl running, no results yet", action: "View" };
  const pages = d.latest.pagesWithErrors;
  const change = d.changes?.pagesWithErrors;
  const crawled = `Crawled ${chartDay(todayIn(d.timeZone, new Date(d.latest.finishedAt)))}`;
  return {
    ...base,
    href: r.module.href,
    state: "value",
    meta: change == null ? crawled : `${crawled} · vs previous crawl`,
    from: change == null ? undefined : formatNumber(pages - change),
    to: formatNumber(pages),
    delta: change == null ? null : countDeltaFromZero(pages, pages - change, "down"),
  };
}

function alsoMoved(results: ModuleResult[]): ChangeRow[] {
  // A source whose newest check failed has nothing new to say.
  const loaded = results.flatMap((r) => (r.status === "ok" && !r.lastRunFailed ? [{ module: r.module, data: r.data }] : []));
  const { worse, better } = pickHighlights(loaded, SHOWN_IN_ROWS);
  return [...worse, ...better].map((h) => ({
    key: h.key,
    label: h.label,
    source: h.module,
    href: h.href,
    // Some baselines are full dates; the fixed rows above leave the year off.
    meta: `vs ${h.baseline.replace(/, \d{4}$/, "")}`,
    state: "value",
    from: h.from,
    to: h.to,
    delta: { text: h.short, tone: h.tone, up: h.up },
  }));
}

/** A figure's state when its module has nothing to show. `onStarter`: as for `emptyRow`. */
function emptyFigure(base: { id: string; label: string }, r: Result, when: { setup: string; action: string; onStarter?: boolean }): FigureData {
  const href = r?.module.href ?? "/";
  const view = { label: `View ${r?.module.label ?? "details"}`, href };
  if (r?.status === "failed") return { ...base, href, state: "empty", text: failedText(r.slow), tone: "bad", action: view };
  if (r?.status === "empty" && r.waiting) return { ...base, href, state: "empty", text: sentence(r.waiting), action: view };
  if (when.onStarter) return { ...base, href: PLANS_HREF, state: "empty", text: ON_STARTER, action: { label: "See plans", href: PLANS_HREF } };
  return { ...base, href, state: "empty", text: when.setup, action: { label: when.action, href: r?.module.setup.href ?? href } };
}

function clicksFigure(r: Result, connected: boolean): FigureData {
  const base = { id: "clicks", label: "Clicks" };
  if (r?.status !== "ok") {
    return emptyFigure(base, r, connected ? { setup: "Connected, waiting for the first sync", action: "View Search Console" } : { setup: "Not connected", action: "Connect Search Console" });
  }
  const d = r.data as GoogleDashboardData;
  const days = storedDays(d, 28);
  return {
    ...base,
    href: r.module.href,
    caption: `${days} day${days === 1 ? "" : "s"} to ${chartDay(d.end)}, ${d.previous ? "vs the 28 before" : "nothing earlier to compare"}`,
    state: "value",
    value: formatNumber(d.current.clicks),
    delta: countDelta(d.current.clicks, d.previous?.clicks),
  };
}

/** Tracked position when keywords are tracked, else what Search Console reports. The label says which: they're different numbers. */
function positionFigure(rank: Result, google: Result, free: boolean): FigureData {
  const base = { id: "position", label: "Tracked position" };
  if (rank?.status !== "ok") {
    const fallback = searchConsolePosition(google);
    return fallback ?? emptyFigure(base, rank, { setup: "No tracked keywords yet", action: "Add keywords", onStarter: free });
  }
  const d = rank.data as RankDashboardData;
  const pos = d.latest.avgPosition;
  if (pos == null) return { ...base, href: rank.module.href, state: "empty", text: "None of these keywords rank yet", action: { label: `View ${rank.module.label}`, href: rank.module.href } };
  const prev = d.previous?.avgPosition ?? null;
  return {
    ...base,
    href: rank.module.href,
    // The average covers only the keywords that rank, so the caption counts those.
    caption: `${formatNumber(d.ranking)} of ${formatNumber(d.keywords)} ranking${positionNote(d.latest)}, ${prev == null ? "nothing earlier to compare" : `vs ${chartDay(d.previous!.date)}`}`,
    state: "value",
    value: pos.toFixed(1),
    delta: prev == null ? null : changeDelta(pos - prev, "decimal", "down", true),
    position: { value: pos, previous: prev },
  };
}

function searchConsolePosition(r: Result): FigureData | null {
  if (r?.status !== "ok") return null;
  const { current: cur, previous: prev } = r.data as GoogleDashboardData;
  if (!cur.impressions) return null;
  const before = prev?.impressions ? prev.position : null;
  return {
    id: "position",
    label: "Search Console position",
    href: r.module.href,
    caption: `Average across searches, ${before == null ? "nothing earlier to compare" : "vs the 28 days before"}`,
    state: "value",
    value: cur.position.toFixed(1),
    delta: before == null ? null : changeDelta(cur.position - before, "decimal", "down", true),
    position: { value: cur.position, previous: before },
  };
}

function pageOneFigure(r: Result, free: boolean): FigureData {
  const base = { id: "page-one", label: "On page one" };
  if (r?.status !== "ok") return emptyFigure(base, r, { setup: "No tracked keywords yet", action: "Add keywords", onStarter: free });
  const d = r.data as RankDashboardData;
  const prev = d.previous?.top10 ?? null;
  return {
    ...base,
    href: r.module.href,
    caption: `in the top 10, ${d.latest.top10NotConfirmed ? `${pageOneNotConfirmed(d.latest)}, ` : ""}${prev == null ? "nothing earlier to compare" : `vs ${chartDay(d.previous!.date)}`}`,
    state: "value",
    value: `${formatNumber(d.latest.top10)} of ${formatNumber(d.keywords)}`,
    delta: pageOneDelta(d),
  };
}

function citedFigure(r: Result, free: boolean): FigureData {
  const base = { id: "cited", label: "AI citing you" };
  if (r?.status !== "ok") return emptyFigure(base, r, { setup: "No tracked prompts yet", action: "Add prompts", onStarter: free });
  const d = r.data as AiDashboardData;
  return {
    ...base,
    href: r.module.href,
    // Failed answers are left out of the count, so it says how many. After a run that got nothing back there's an earlier run, and the failure says why there's no change.
    caption: [plural(d.engines, "platform"), d.failed ? `${formatNumber(d.failed)} failed` : null, d.previous ? "vs previous run" : d.failedRun ? null : "nothing earlier to compare"].filter(Boolean).join(", "),
    state: "value",
    value: ofTotal(d.current),
    delta: citedDelta(d),
  };
}

function healthFigure(r: Result): FigureData {
  const base = { id: "health", label: "Health score" };
  if (r?.status !== "ok") return emptyFigure(base, r, { setup: "No crawl yet", action: "Run a crawl" });
  const d = r.data as AuditDashboardData;
  const view = { label: `View ${r.module.label}`, href: r.module.href };
  if (!d.latest) return { ...base, href: r.module.href, state: "empty", text: "Crawl running, no results yet", action: view };
  const score = d.latest.score;
  if (score == null) return { ...base, href: r.module.href, state: "empty", text: "No score from this crawl", action: view };
  const change = d.changes?.score ?? null;
  const crawled = `out of 100, crawled ${chartDay(todayIn(d.timeZone, new Date(d.latest.finishedAt)))}`;
  return {
    ...base,
    href: r.module.href,
    caption: change == null ? crawled : `${crawled}, vs previous crawl`,
    state: "value",
    value: formatNumber(score),
    delta: change == null ? null : changeDelta(change, "number", "up"),
  };
}
