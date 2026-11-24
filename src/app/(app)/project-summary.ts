import type { FigureData } from "@/components/ui/figure";
import { chartDay, countChange, describeChange, magnitude, shownChange, type KpiChange } from "@/components/ui/module-card";
import { changeWeight, enoughData, type ChangeDelta } from "@/components/ui/what-changed";
import { briefSentence, changeDelta, countDelta, countDeltaFromZero, countMove, countOf, countWord, MIN_WEIGHT, type Move } from "@/lib/brief";
import { failureTone, failureWords, needsLookClause, needsLookSentence, staleCaption, withoutTone, type LookingAt } from "@/lib/check-failure";
import { chooseChart, fillDays, weeklyBuckets, type SeriesPoint } from "@/lib/chart-rule";
import { formatNumber, formatShortDate } from "@/lib/format";
import type { AiDashboardData } from "@/modules/ai/dashboard";
import type { AuditDashboardData } from "@/modules/audit/dashboard";
import type { BacklinksDashboardData } from "@/modules/backlinks/dashboard";
import { monthLabel } from "@/modules/domains/brief";
import type { DomainsDashboardData } from "@/modules/domains/dashboard";
import type { GoogleDashboardData } from "@/modules/google/dashboard";
import type { Ga4DashboardData } from "@/modules/google/ga4-dashboard";
import { addDays, storedDays, todayIn } from "@/modules/google/windowing";
import type { LocalDashboardData } from "@/modules/local/dashboard";
import { sameGrid } from "@/modules/local/metrics";
import type { RankDashboardData } from "@/modules/rank/dashboard";
import { pageOneGainUnconfirmed } from "@/modules/rank/metrics";
// dashboard-headlines imports this file too. Only functions cross, and only at call time, so the loop is harmless.
import { clicksThisWeek } from "./dashboard-headlines";
import type { ModuleResult } from "./dashboard-load";

/** A change in points for a sentence, from the figure's own rounding: "6.3 points", where the figure beside it reads "6.3 pts". */
function pointsInWords(change: number): string {
  const size = magnitude(change, "points").replace(/ pts?$/, "");
  return `${size} ${size === "1" ? "point" : "points"}`;
}

const DAYS = 28;

/** A count has to move by this many to raise the flag, the same floor "What changed" sets for a count at all. */
const MIN_COUNT_MOVE = 20;
/** Site health has to move by this many points to raise the flag. "What changed" treats moves under 3 as small too. */
const MIN_HEALTH_MOVE = 3;

const find = <D,>(results: ModuleResult[], id: string): D | null => {
  const r = results.find((x) => x.module.id === id);
  return r?.status === "ok" ? (r.data as D) : null;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The sources whose newest check failed or whose connection needs redoing. A module that couldn't load says so itself. */
export function needsLook(results: ModuleResult[]): LookingAt[] {
  return results.flatMap((r) => (r.lastRunFailed && r.status !== "failed" ? [{ label: r.module.label, failure: r.lastRunFailed }] : []));
}

/** The results with a failing source's numbers set aside, so what they say about change can't read as news. */
export function withoutFailing(results: ModuleResult[]): ModuleResult[] {
  return results.map((r) => (r.lastRunFailed && r.status === "ok" ? { module: r.module, status: "empty" } : r));
}

/** The day a module's numbers are from, for those whose caption can read as if they were current. */
export function dataDay(r: ModuleResult | undefined): string | null {
  if (r?.status !== "ok") return null;
  if (r.module.id === "rank") return chartDay((r.data as RankDashboardData).latest.date);
  if (r.module.id === "ai") {
    const d = r.data as AiDashboardData;
    return chartDay(todayIn(d.timeZone, new Date(d.lastRunAt)));
  }
  return null;
}

/** A move worth a clause. `solid`: it rests on enough to raise the flag and lead the sentence. */
export interface ProjectMove extends Move {
  solid: boolean;
  /** Which number it's about, so a page can lead with one it shows. */
  id?: string;
}

const about = (id: string, move: ProjectMove | null): ProjectMove | null => move && { ...move, id };

/**
 * Clicks or sessions against the period before. 39 → 33 is said in passing; 14 → 37 is worth reading. Where
 * the figure beside it shows the plain difference, the sentence gives the two numbers it came from.
 */
function countSaid(noun: string, now: number, before: number | null | undefined, against: string): ProjectMove | null {
  if (before == null) return null;
  const between = `from ${formatNumber(before)} to ${formatNumber(now)} ${against}`;
  if (before === 0) return now >= MIN_COUNT_MOVE ? { clause: `${noun} are up ${between}`, tone: "good", weight: 1, solid: true } : null;
  const move = countMove(noun, now, before, against);
  if (!move) return null;
  return {
    ...move,
    clause: countChange(now, before).unit === "number" ? `${noun} are ${now > before ? "up" : "down"} ${between}` : move.clause,
    solid: Math.abs(now - before) >= MIN_COUNT_MOVE,
  };
}

/**
 * A few keywords or answers gained or lost. It's solid by the weight "What changed" gives it, which scales
 * moves under 3 down, so losing one of four keywords doesn't outrank a 40% fall in traffic.
 */
function stepMove(clause: string, tone: Move["tone"], from: number, to: number): ProjectMove {
  const scaled = Math.min(1, changeWeight({ from, to, unit: "number" }));
  const solid = scaled >= MIN_WEIGHT;
  return { clause, tone, solid, weight: solid ? scaled : Math.min(1, Math.abs(to - from) / Math.max(from, 1)) };
}

/** Everything moved enough to say, across the six numbers every project is compared on. */
export function projectMoves(results: ModuleResult[]): ProjectMove[] {
  const google = find<GoogleDashboardData>(results, "google");
  const ga4 = find<Ga4DashboardData>(results, "ga4");
  const rank = find<RankDashboardData>(results, "rank");
  const ai = find<AiDashboardData>(results, "ai");
  const audit = find<AuditDashboardData>(results, "audit");
  const backlinks = find<BacklinksDashboardData>(results, "backlinks");
  const moves: (ProjectMove | null)[] = [];
  const against = `on the ${DAYS} days before`;

  if (google) moves.push(about("clicks", countSaid("clicks", google.current.clicks, google.previous?.clicks, against)));
  if (ga4) moves.push(about("sessions", countSaid("organic sessions", ga4.current.sessions, ga4.previous?.sessions, against)));

  if (rank?.previous) {
    const { top10: was } = rank.previous;
    const { top10: now } = rank.latest;
    const n = Math.abs(now - was);
    // The net change in the count, so it doesn't say how many reached page one or left it: the Rankings page does.
    const then = `on page one than on ${chartDay(rank.previous.date)}`;
    const verb = n === 1 ? "is" : "are";
    // "Counting", not "of them": the net change can be smaller than the gains no look confirmed. "That reached it"
    // keeps these apart from the card's count of every page one keyword not confirmed.
    const counting = rank.pageOneGainsNotConfirmed ? `, counting ${formatNumber(rank.pageOneGainsNotConfirmed)} that reached it on positions not confirmed` : "";
    // A gain that rests wholly on positions no look confirmed shows on page one, and isn't news either way.
    if (now > was && pageOneGainUnconfirmed(rank)) moves.push(about("page-one", stepMove(`${countOf(n, "more keyword", "more keywords")} ${n === 1 ? "shows" : "show"} ${then}, with none of the gain confirmed`, "neutral", was, now)));
    else if (now > was) moves.push(about("page-one", stepMove(`${countOf(n, "more keyword", "more keywords")} ${verb} ${then}${counting}`, "good", was, now)));
    if (now < was) moves.push(about("page-one", stepMove(`${countOf(n, "fewer keyword", "fewer keywords")} ${verb} ${then}`, "bad", was, now)));
  }

  if (ai?.previous) {
    const { current: cur, previous: prev } = ai;
    if (cur.total === prev.total) {
      const change = cur.cited - prev.cited;
      const n = Math.abs(change);
      const verb = n === 1 ? "cites" : "cite";
      if (n) moves.push(about("cited", stepMove(`${countWord(n)} ${change > 0 ? "more" : "fewer"} AI ${n === 1 ? "answer" : "answers"} ${verb} you than in the previous run`, change > 0 ? "good" : "bad", prev.cited, cur.cited)));
    } else if (cur.citedRate != null && prev.citedRate != null) {
      // Prompts came or went, so the counts can't be compared; the share can.
      const change = cur.citedRate - prev.citedRate;
      // In the figure's own words, so the sentence can't disagree with the number beside it, and silent when that reads "No change".
      if (changeDelta(change, "points", "up").tone !== "muted") {
        moves.push({ id: "cited", clause: `the share of AI answers citing you ${change > 0 ? "rose" : "fell"} ${pointsInWords(Math.abs(change))} since the previous run`, tone: change > 0 ? "good" : "bad", weight: Math.abs(change) / Math.max(prev.citedRate, 0.05), solid: true });
      }
    }
    // Answers can cite you more while fewer of them name you, so citing alone can hide a fall.
    if (cur.score != null && prev.score != null) {
      const change = cur.score - prev.score;
      if (changeDelta(change, "points", "up").tone !== "muted") {
        moves.push({ id: "ai-visibility", clause: `AI visibility ${change > 0 ? "rose" : "fell"} ${pointsInWords(Math.abs(change))} since the previous run`, tone: change > 0 ? "good" : "bad", weight: Math.abs(change) / Math.max(prev.score, 0.05), solid: true });
      }
    }
  }

  const health = audit?.changes?.score;
  if (health) {
    // Scores carry a decimal, and their difference can carry float noise, so the words use the whole points.
    const n = Math.round(Math.abs(health));
    if (n) moves.push({ id: "health", clause: `health score ${health > 0 ? "rose" : "fell"} ${countOf(n, "point")} since the previous crawl`, tone: health > 0 ? "good" : "bad", weight: Math.min(1, Math.abs(health) / 10), solid: n >= MIN_HEALTH_MOVE });
  }

  if (backlinks?.backlinksChange && backlinks.previousDate) {
    const change = backlinks.backlinksChange;
    const before = backlinks.backlinks - change;
    const n = Math.abs(change);
    if (enoughData({ from: before, to: backlinks.backlinks, unit: "percent" })) {
      moves.push({ id: "backlinks", clause: `you ${change > 0 ? "gained" : "lost"} ${countOf(n, "backlink")} since ${chartDay(backlinks.previousDate)}`, tone: change > 0 ? "good" : "bad", weight: Math.min(1, n / Math.max(before, 1)), solid: n >= MIN_COUNT_MOVE });
    }
  }

  return moves.filter((m): m is ProjectMove => m != null && m.weight >= MIN_WEIGHT);
}

/**
 * What moved in Domain analysis and Local SEO. They aren't among the six numbers, so these never raise
 * a project's flag or lead over them. They speak when a project has nothing else to compare.
 */
function otherMoves(results: ModuleResult[]): Move[] {
  const moves: (Move | null)[] = [];
  const domains = find<DomainsDashboardData>(results, "domains");
  if (domains?.previous) {
    const { latest: cur, previous: prev } = domains;
    const month = monthLabel(prev.month);
    const since = `since ${month}`;
    moves.push(countMove("estimated visits", cur.traffic, prev.traffic, since), countMove("ranking keywords", cur.keywords, prev.keywords, since));
    const n = Math.abs(cur.top10 - prev.top10);
    // The net change in the count, so it doesn't say how many reached the top 10 or left it.
    const inTop10 = `${n === 1 ? "is" : "are"} in the top 10 than in ${month}`;
    if (cur.top10 > prev.top10) moves.push(stepMove(`${countOf(n, "more keyword", "more keywords")} ${inTop10}`, "good", prev.top10, cur.top10));
    if (cur.top10 < prev.top10) moves.push(stepMove(`${countOf(n, "fewer keyword", "fewer keywords")} ${inTop10}`, "bad", prev.top10, cur.top10));
  }
  const local = find<LocalDashboardData>(results, "local");
  if (local?.previous) {
    const { latest: cur, previous: prev, timeZone } = local;
    const since = `since ${formatShortDate(prev.at, timeZone)}`;
    if (cur.avgRank != null && prev.avgRank != null && cur.avgRank.toFixed(1) !== prev.avgRank.toFixed(1)) {
      moves.push({ clause: `average map rank went from ${prev.avgRank.toFixed(1)} to ${cur.avgRank.toFixed(1)} ${since}`, tone: cur.avgRank < prev.avgRank ? "good" : "bad", weight: Math.abs(cur.avgRank - prev.avgRank) / Math.max(prev.avgRank, 1) });
    }
    // On the same grid a share's change is a count of points, as Local SEO's page says it; a grid that changed size compares shares.
    const share = (where: string, now: number | null, before: number | null) => {
      if (now == null || before == null || changeDelta(now - before, "points", "up").tone === "muted") return null;
      const tone = now > before ? "good" : "bad";
      const weight = Math.abs(now - before) / Math.max(before, 0.05);
      if (sameGrid(cur, prev)) {
        const [was, is] = [Math.round(before * prev.answered), Math.round(now * cur.answered)];
        if (was === is) return null;
        return { clause: `map points ${where} went from ${formatNumber(was)} to ${formatNumber(is)} of ${formatNumber(cur.answered)} ${since}`, tone, weight } as const;
      }
      return { clause: `the share of map points ${where} ${now > before ? "rose" : "fell"} ${pointsInWords(Math.abs(now - before))} ${since}`, tone, weight } as const;
    };
    moves.push(share("in the top 3", cur.top3, prev.top3), share("where you appear", cur.found, prev.found));
  }
  return moves.filter((m): m is Move => m != null);
}

/** Whether any of the six numbers has an earlier reading. */
const sixHaveEarlier = (results: ModuleResult[]) =>
  !!(
    find<GoogleDashboardData>(results, "google")?.previous ||
    find<Ga4DashboardData>(results, "ga4")?.previous ||
    find<RankDashboardData>(results, "rank")?.previous ||
    find<AiDashboardData>(results, "ai")?.previous ||
    find<AuditDashboardData>(results, "audit")?.changes ||
    find<BacklinksDashboardData>(results, "backlinks")?.previousDate
  );

/** Whether any module has an earlier reading, so "nothing moved" means something. */
const hasEarlier = (results: ModuleResult[]) => sixHaveEarlier(results) || !!find<DomainsDashboardData>(results, "domains")?.previous || !!find<LocalDashboardData>(results, "local")?.previous;

/** Whether a module's change prints as one, read the way "What changed" and the module's own figure read it. */
function printsAsChange(c: KpiChange): boolean {
  const { value, unit } = shownChange(c);
  return describeChange(value, unit, c.goodWhen).tone !== "muted";
}

/**
 * Whether any number a project shows has changed, however small: a figure on the card, a change a loaded
 * module lists, or the 7-day clicks and pages with errors that its Overview adds. "Nothing moved" is only true without one.
 */
function anythingShowsChange(results: ModuleResult[]): boolean {
  // An arrow is a change too, even in a neutral tone: a page one gain no look confirmed.
  const onCard = projectFigures(results).some((f) => f.state === "value" && f.delta != null && (f.delta.tone !== "muted" || f.delta.up != null));
  if (onCard) return true;
  if (results.some((r) => r.status === "ok" && r.module.changes?.(r.data).some((c) => c != null && printsAsChange(c)))) return true;
  const google = find<GoogleDashboardData>(results, "google");
  if (google) {
    const week = clicksThisWeek(google);
    const delta = countDeltaFromZero(week.current, week.previous);
    if (delta && delta.tone !== "muted") return true;
  }
  return !!find<AuditDashboardData>(results, "audit")?.changes?.pagesWithErrors;
}

/** The only thing a project has to show is a first crawl still running: no reading to call first, and nothing to compare. */
function onlyFirstCrawl(results: ModuleResult[]): boolean {
  const audit = find<AuditDashboardData>(results, "audit");
  return !!audit?.running && !audit.latest && results.filter((r) => r.status === "ok").length === 1;
}

const waitingLines = (results: ModuleResult[]) => results.flatMap((r) => (r.status === "empty" && r.waiting ? [`${capitalize(r.waiting)}.`] : []));

/** The sentence every project gets on its card. Its Overview leads with the numbers it shows, and falls back to this. */
export function projectSentence(results: ModuleResult[]): string {
  const looking = needsLook(results);
  if (looking.length) {
    // Only what the healthy sources moved. Never "small changes" or "first readings": a source is stuck.
    const moved = briefSentence(projectMoves(withoutFailing(results)).filter((m) => m.solid), "");
    return moved ? `${needsLookSentence(looking)} ${moved}` : needsLookSentence(looking);
  }
  if (onlyFirstCrawl(results)) return ["A crawl is running. Results show when it finishes.", ...waitingLines(results)].join(" ");
  if (!results.some((r) => r.status === "ok")) {
    const waiting = waitingLines(results);
    if (waiting.length) return waiting.join(" ");
    return results.some((r) => r.status === "failed") ? "Couldn't load the numbers for this project." : "Nothing set up yet.";
  }
  const moves = projectMoves(results);
  const solid = moves.filter((m) => m.solid);
  if (solid.length) return briefSentence(solid, "");
  if (!sixHaveEarlier(results)) {
    const others = briefSentence(otherMoves(results), "");
    if (others) return others;
  }
  if (!hasEarlier(results)) return "First readings are in. Changes show from the next check.";
  const [small] = [...moves].sort((a, b) => b.weight - a.weight);
  if (small) return `Only small changes: ${small.clause}.`;
  return anythingShowsChange(results) ? "Only small changes against the last checks." : "Nothing moved against the last checks.";
}

/** What the card draws beside its sentence, or null when there's no trend worth drawing. */
export interface ClicksSpark {
  points: SeriesPoint[];
  /** Said on the card and read aloud: "Clicks, 28 days". */
  label: string;
}

export interface ProjectSummary {
  sentence: string;
  /** Clicks, On page one, AI citing you, Health score, Organic sessions, Backlinks, always in that order. */
  figures: FigureData[];
  clicksSpark: ClicksSpark | null;
  /** `waiting`: set up, with no results yet. `empty`: nothing set up. */
  status: "attention" | "steady" | "waiting" | "empty";
  /** How far the worst solid fall went, for sorting by what needs a look. Zero with none. */
  worst: number;
  /** How many sources' newest check failed or need reconnecting. */
  looking: number;
  /** The biggest solid move either way, for sorting by change. */
  biggest: number;
  failed: { label: string; slow: boolean }[];
  /** Number of modules with data. */
  live: number;
  /** Whether any module has an earlier reading, so "steady" compares against something. */
  compared: boolean;
}

/** "28 days to Oct 30", or fewer on a property with less stored. */
function storedSpan(d: GoogleDashboardData | Ga4DashboardData): string {
  const days = storedDays(d, DAYS);
  return `${days} day${days === 1 ? "" : "s"} to ${chartDay(d.end)}`;
}

function figure(results: ModuleResult[], id: string, moduleId: string, label: string, read: (data: never) => Omit<Extract<FigureData, { state: "value" }>, "id" | "label" | "state"> | null): FigureData {
  const r = results.find((x) => x.module.id === moduleId);
  const base = { id, label };
  if (r?.status === "failed") return { ...base, state: "empty", text: r.slow ? "Took too long" : "Couldn't load", tone: "bad" };
  const failure = r?.lastRunFailed;
  if (r?.status !== "ok") {
    if (failure) return { ...base, state: "empty", text: failureWords(failure), tone: failureTone(failure) };
    return { ...base, state: "empty", text: r?.status === "empty" && r.waiting ? "Waiting for first results" : "Not set up" };
  }
  const value = read(r.data as never);
  if (!value) return failure ? { ...base, state: "empty", text: failureWords(failure), tone: failureTone(failure) } : { ...base, state: "empty", text: "Nothing yet" };
  return { ...base, state: "value", ...value, delta: withoutTone(value.delta, failure), caption: failure ? staleCaption(value.caption, failure, dataDay(r)) : value.caption };
}

/**
 * The six figures on a project's card. They carry no links: the module pages read the current project,
 * which isn't this card's until it's opened.
 */
function projectFigures(results: ModuleResult[]): FigureData[] {
  return [
    figure(results, "clicks", "google", "Clicks", (d: GoogleDashboardData) => ({
      value: formatNumber(d.current.clicks),
      delta: countDelta(d.current.clicks, d.previous?.clicks),
      caption: storedSpan(d),
    })),
    figure(results, "page-one", "rank", "On page one", (d: RankDashboardData) => ({
      value: `${formatNumber(d.latest.top10)} of ${formatNumber(d.keywords)}`,
      delta: pageOneDelta(d),
      caption: `${d.latest.top10NotConfirmed ? `${pageOneNotConfirmed(d.latest)}, ` : ""}${d.previous ? `vs ${chartDay(d.previous.date)}` : `keywords, checked ${chartDay(d.latest.date)}`}`,
    })),
    figure(results, "cited", "ai", "AI citing you", (d: AiDashboardData) => ({
      value: `${formatNumber(d.current.cited)} of ${formatNumber(d.current.total)}`,
      delta: citedDelta(d),
      // Failed answers are left out of the count, so it says how many. After a run that got nothing back it isn't a first run: the failure says why there's no change.
      caption: [d.previous ? "vs the previous run" : d.failedRun ? null : "first run", d.failed ? `${formatNumber(d.failed)} failed` : null].filter(Boolean).join(", ") || undefined,
    })),
    figure(results, "health", "audit", "Health score", (d: AuditDashboardData) =>
      d.latest?.score == null
        ? null
        : {
            value: formatNumber(d.latest.score),
            delta: d.changes?.score == null ? null : changeDelta(d.changes.score, "number", "up"),
            caption: `crawled ${chartDay(todayIn(d.timeZone, new Date(d.latest.finishedAt)))}`,
          },
    ),
    figure(results, "sessions", "ga4", "Organic sessions", (d: Ga4DashboardData) => ({
      value: formatNumber(d.current.sessions),
      delta: countDelta(d.current.sessions, d.previous?.sessions),
      caption: storedSpan(d),
    })),
    figure(results, "backlinks", "backlinks", "Backlinks", (d: BacklinksDashboardData) => ({
      value: formatNumber(d.backlinks),
      delta: d.backlinksChange == null ? null : countDelta(d.backlinks, d.backlinks - d.backlinksChange),
      // The stored snapshots the sentence compares, so the change beside it says what it's against.
      caption: d.previousDate ? `as of ${chartDay(d.date)}, vs ${chartDay(d.previousDate)}` : `as of ${chartDay(d.date)}`,
    })),
  ];
}

/** One project's card on All projects. Pure, so every state can be previewed at /dev/cards. */
export function summarize(results: ModuleResult[]): ProjectSummary {
  const moves = projectMoves(withoutFailing(results)).filter((m) => m.solid);
  const looking = needsLook(results).length;
  const failed = results.flatMap((r) => (r.status === "failed" ? [{ label: r.module.label, slow: r.slow }] : []));
  const crawling = onlyFirstCrawl(results);
  const live = crawling ? 0 : results.filter((r) => r.status === "ok").length;
  const worst = Math.max(0, ...moves.filter((m) => m.tone === "bad").map((m) => m.weight));
  const waiting = crawling || results.some((r) => r.status === "empty" && r.waiting);
  const google = find<GoogleDashboardData>(results, "google");

  return {
    sentence: projectSentence(results),
    figures: projectFigures(results),
    clicksSpark: google ? clicksSpark(clicksDays(google)) : null,
    status: worst > 0 || failed.length || looking ? "attention" : live ? "steady" : waiting ? "waiting" : "empty",
    worst,
    looking,
    biggest: Math.max(0, ...moves.map((m) => m.weight)),
    failed,
    live,
    compared: hasEarlier(results),
  };
}

/** The window's days, with the days inside stored history that have no row counted as zero. */
function clicksDays(d: GoogleDashboardData): SeriesPoint[] {
  const first = d.series[0]?.date;
  const windowStart = addDays(d.end, -(DAYS - 1));
  const start = d.previous || !first || first < windowStart ? windowStart : first;
  return fillDays(d.series, start, d.end, (r) => r.clicks);
}

/**
 * Quiet and the same on every card, with a caption so it can't be read as whichever number sits beside it.
 * Few clicks a day would draw a row of spikes that mean nothing, so it follows the chart rule and adds them up by week.
 */
export function clicksSpark(days: SeriesPoint[]): ClicksSpark | null {
  const choice = chooseChart(days, { counts: true });
  if (choice.kind !== "line" && choice.kind !== "columns") return null;
  const weekly = choice.kind === "columns" && choice.bucket === "week";
  const points = weekly ? weeklyBuckets(days).map((w) => ({ date: w.date, value: w.value })) : days;
  // Whole weeks can leave too little to draw, and a caption shouldn't stand alone.
  const values = points.flatMap((p) => (p.value == null ? [] : [p.value]));
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  return { points, label: weekly ? `Clicks, ${points.length * 7} days, by week` : `Clicks, ${days.length} days` };
}

/** Page one's keywords no look confirmed, out of all on it, so it can't read as the gain's count: "7 of the 23 not confirmed". */
export function pageOneNotConfirmed(s: { top10: number; top10NotConfirmed: number }): string {
  return `${formatNumber(s.top10NotConfirmed)} of the ${formatNumber(s.top10)} not confirmed`;
}

export function pageOneDelta(d: RankDashboardData): ChangeDelta | null {
  if (!d.previous) return null;
  const delta = changeDelta(d.latest.top10 - d.previous.top10, "number", "up");
  return pageOneGainUnconfirmed(d) ? { ...delta, tone: "muted" } : delta;
}

/** Cited answers against the previous run. When prompts came or went, the counts can't be compared, so the share is. */
export function citedDelta(d: AiDashboardData) {
  const { current: cur, previous: prev } = d;
  if (!prev) return null;
  if (cur.total === prev.total) return changeDelta(cur.cited - prev.cited, "number", "up");
  return cur.citedRate != null && prev.citedRate != null ? changeDelta(cur.citedRate - prev.citedRate, "points", "up") : null;
}

export interface BoardEntry {
  name: string;
  summary: Pick<ProjectSummary, "status" | "worst" | "compared">;
  /** The worst thing that moved, as a clause. */
  worstClause?: string;
}

/** Nothing fell. It only says "steady against their last checks" of the projects that had a last check. */
function steadySentence(live: BoardEntry[]): string {
  const total = live.length;
  const compared = live.filter((e) => e.summary.compared).length;
  const next = "Changes show from the next check.";
  if (total === 1) return compared ? "Your one live project looks steady against its last checks." : `Your one live project has only first readings. ${next}`;
  if (!compared) return `All ${countWord(total)} projects have only first readings. ${next}`;
  if (compared === total) return `All ${countWord(total)} projects look steady against their last checks.`;
  const steady = compared === 1 ? "looks steady against its last checks" : "look steady against their last checks";
  const rest = total - compared === 1 ? "The other has only first readings." : "The others have only first readings.";
  return `${capitalize(countWord(compared))} of ${countWord(total)} projects ${steady}. ${rest}`;
}

/** The projects with something to read, for the sentence above. */
function liveSentence(live: BoardEntry[]): string {
  const flagged = live.filter((e) => e.summary.status === "attention").sort((a, b) => b.summary.worst - a.summary.worst);
  if (!flagged.length) return steadySentence(live);
  const top = flagged[0];
  if (live.length === 1) return top.worstClause ? `${top.name} needs a look: ${top.worstClause}.` : `${top.name} needs a look.`;
  const count = flagged.length === 1 ? "One project needs a look" : `${capitalize(countWord(flagged.length))} projects need a look`;
  return top.worstClause ? `${count}. Most of all ${top.name}: ${top.worstClause}.` : `${count}.`;
}

/** The sentence at the top of All projects. */
export function boardSentence(entries: BoardEntry[]): string {
  const live = entries.filter((e) => e.summary.status === "attention" || e.summary.status === "steady");
  const waiting = entries.filter((e) => e.summary.status === "waiting");
  const n = waiting.length;
  if (live.length) {
    if (!n) return liveSentence(live);
    return `${liveSentence(live)} ${n === 1 ? "Another is set up and waiting for its first results." : `${capitalize(countWord(n))} others are set up and waiting for their first results.`}`;
  }
  if (n === 1) return `${waiting[0].name} is set up and waiting for its first results.`;
  if (n) return `${capitalize(countWord(n))} projects are set up and waiting for their first results.`;
  return "Nothing is set up yet. Open a project to start.";
}

/** The worst thing that moved enough to flag, for the sentence above. */
export function worstClause(results: ModuleResult[]): string | undefined {
  const fall = projectMoves(withoutFailing(results))
    .filter((m) => m.tone === "bad" && m.solid)
    .sort((a, b) => b.weight - a.weight)[0]?.clause;
  const looking = needsLook(results);
  return fall ?? (looking.length ? needsLookClause(looking) : undefined);
}
