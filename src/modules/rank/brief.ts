/** The top of the Rankings page, from the same overview the table reads. Pure, so it's tested and costs nothing. */
import type { FigureData } from "@/components/ui/figure";
import { chartDay, inPoints } from "@/components/ui/module-card";
import { changeDelta, countDelta, countOf, countWord } from "@/lib/brief";
import { chooseChart, chooseLines, type SeriesPoint } from "@/lib/chart-rule";
import { formatDateTimeZoned, formatDay, formatNumber, formatPct, formatTimestamp } from "@/lib/format";
import type { CompetitorView } from "./competitors";
import { featureLabel } from "./features";
import type { Summary } from "./metrics";
import type { Overview } from "./overview";
import type { CannibalRow, PageRow } from "./pages";

const PAGE_ONE = 10;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const onPageOne = (position: number | null) => position != null && position <= PAGE_ONE;

/**
 * ", vs Oct 28" to close a caption, or nothing when there's nothing earlier. On one check the page's
 * sentence already says changes show after the next one, so the captions just describe their numbers.
 */
const sinceClause = (date: string | null | undefined) => (date ? `, vs ${chartDay(date)}` : "");

const TRAFFIC_CAPTION = "what these positions would bring";

/**
 * A share no look confirmed, in the points its figure's change reads in, at the figure's own `digits`:
 * "7.2 pts not confirmed". Nothing when it rounds away, since then it doesn't change the figure.
 */
export function pointsNotConfirmed(share: number | null | undefined, digits = 1): string {
  const points = Math.round((share ?? 0) * 10 ** (digits + 2)) / 10 ** digits;
  return points ? `${inPoints(String(points))} not confirmed` : "";
}

/** Visibility's share that no look confirmed, to close a clause. */
const visibilityNote = (share: number | undefined) => {
  const note = pointsNotConfirmed(share);
  return note ? `, ${note}` : "";
};

/**
 * Tracked position's note, only when the positions no look confirmed move the average as it reads: how
 * many there are, and the average without them when any confirmed position is left.
 */
export const positionNote = (end: Pick<Summary, "avgPosition" | "avgPositionConfirmed" | "rankingNotConfirmed"> | null | undefined) => {
  const n = end?.rankingNotConfirmed;
  if (!n || end.avgPosition == null) return "";
  const without = end.avgPositionConfirmed;
  if (without != null && without.toFixed(1) === end.avgPosition.toFixed(1)) return "";
  return `, ${formatNumber(n)} not confirmed${without != null ? `, ${without.toFixed(1)} without them` : ""}`;
};

/** For the Trend chart's caption: whether its newest check counts positions no look confirmed. Nothing when it doesn't. */
export function trendNote(end: Pick<Summary, "rankingNotConfirmed"> & { date: string } | null | undefined): string {
  const n = end?.rankingNotConfirmed;
  return n ? `the ${chartDay(end.date)} check counts ${formatNumber(n)} ${n === 1 ? "position" : "positions"} not confirmed` : "";
}

/**
 * For the Competitors "Over time" chart: whether its newest check repeats results no look confirmed.
 * Those keywords keep every domain's old position, so it counts keywords, not one site's positions.
 */
export function keywordsNotConfirmedNote(n: number, date: string): string {
  return n ? `the ${chartDay(date)} check counts ${formatNumber(n)} ${n === 1 ? "keyword" : "keywords"} not confirmed, for every domain` : "";
}

/** Est. traffic's share that no look confirmed. Nothing when it rounds away. */
const trafficNote = (traffic: number | undefined) => {
  const n = Math.round(traffic ?? 0);
  return n ? `${formatNumber(n)} not confirmed` : "";
};

/** "Nov 3, 2026 to Nov 9, 2026", or just "Nov 3, 2026" when the first and last day are the same. */
export function dayRange(first: string | null | undefined, last: string | null | undefined): string {
  return first === last ? formatDay(last) : `${formatDay(first)} to ${formatDay(last)}`;
}

/**
 * The top of /rank before there are results. It only offers Check now when the button would work, and
 * on Free nothing would: the plan runs no rank checks, by hand or on schedule.
 */
export function firstCheckSentence({ running, refused, free = false, time }: { running: boolean; refused: boolean; free?: boolean; time: string }): string {
  if (running) return "The first check is running. Results show here as they come in.";
  if (free) return "Rank checks aren't part of the Free plan, so these keywords won't be checked. Choose a plan on the Billing page to run them.";
  if (refused) return "Waiting for the first check.";
  return `Waiting for the first check. It runs every day at ${time}, or Check now runs one sooner.`;
}

/** How the Overview says a first check is under way. */
export const FIRST_CHECK_RUNNING = "the first check is running";

/** How the Overview says the Free plan won't check these keywords, so nothing is on its way. */
export const NOT_ON_FREE = "not checked on the Free plan";

/** Keywords with no results yet, as the Overview reads it: "8 keywords tracked, the first check is running". */
export function waitingOnFirstCheck(keywords: number, running: boolean, free = false): string {
  return `${keywords} keyword${keywords === 1 ? "" : "s"} tracked, ${running ? FIRST_CHECK_RUNNING : free ? NOT_ON_FREE : "waiting for the first check"}`;
}

/**
 * What moved between the first and last check in the range. Reaching or leaving page one is what most
 * people are watching for, so that leads; otherwise any move at all, and "nothing moved" when that's so.
 */
export function rankSentence(o: Pick<Overview, "rows" | "start" | "end">, { newerFailed = false }: { /** A newer check failed, so these results aren't the latest word. */ newerFailed?: boolean } = {}): string {
  if (!o.end || !o.start) return "Waiting for the first check.";
  if (o.start.date === o.end.date) return newerFailed ? `Only the ${chartDay(o.end.date)} check has results so far.` : `First check on ${chartDay(o.end.date)}. Changes show after the next one.`;
  const said = movedSentence(o, o.start.date);
  return newerFailed ? `As of ${chartDay(o.end.date)}, ${said.charAt(0).toLowerCase()}${said.slice(1)}` : said;
}

/**
 * Only what a check confirmed counts as a move. A keyword that shows on page one on a position no look
 * could confirm, and wasn't there at the start, gets its own words, so the sentence still adds up to the
 * figure beside it, which counts them.
 */
function movedSentence(o: Pick<Overview, "rows">, startDate: string): string {
  const said = confirmedMoves(o.rows.filter((r) => !r.notChecked), startDate);
  const carried = o.rows.filter((r) => r.notChecked && onPageOne(r.position) && !onPageOne(r.start)).length;
  if (!carried) return said;
  const verb = carried === 1 ? "wasn't" : "weren't";
  const be = carried === 1 ? "is" : "are";
  if (said === nothingMoved(startDate)) return `No confirmed moves since ${chartDay(startDate)}. ${capitalize(countOf(carried, "keyword"))} ${be} on page one but ${verb} confirmed.`;
  return `${said} ${capitalize(countWord(carried))} more ${be} on page one but ${verb} confirmed.`;
}

const nothingMoved = (startDate: string) => `Nothing moved since ${chartDay(startDate)}.`;

function confirmedMoves(rows: Pick<Overview, "rows">["rows"], startDate: string): string {
  const since = chartDay(startDate);
  // No position at the start isn't proof of a climb: looks miss real results, so it only says the earlier check didn't find it.
  const reached = rows.filter((r) => r.start != null && !onPageOne(r.start) && onPageOne(r.position)).length;
  const found = rows.filter((r) => r.start == null && onPageOne(r.position)).length;
  const fell = rows.filter((r) => onPageOne(r.start) && !onPageOne(r.position)).length;
  const bare = (n: number) => countOf(n, "keyword").replace(/ keywords?$/, "");
  const missed = `the ${since} check didn't find`;
  if (found && reached && fell) return `${capitalize(countOf(reached, "keyword"))} reached page one and ${bare(found)} ${missed} ${found === 1 ? "is" : "are"} there too, and ${bare(fell)} fell off.`;
  if (found && reached && !fell) return `${capitalize(countOf(reached, "keyword"))} reached page one and ${bare(found)} ${missed} ${found === 1 ? "is" : "are"} there too.`;
  if (found && fell && !reached) return `${capitalize(countOf(found, "keyword"))} ${missed} ${found === 1 ? "is" : "are"} on page one, and ${bare(fell)} fell off.`;
  if (found && !reached && !fell) return `${capitalize(countOf(found, "keyword"))} ${missed} ${found === 1 ? "is" : "are"} on page one.`;
  if (reached && fell) return `${capitalize(countOf(reached, "keyword"))} reached page one and ${countOf(fell, "keyword").replace(/ keywords?$/, "")} fell off, compared with ${since}.`;
  if (reached) return `${capitalize(countOf(reached, "keyword"))} reached page one, compared with ${since}.`;
  if (fell) return `${capitalize(countOf(fell, "keyword"))} fell off page one, compared with ${since}.`;
  const up = rows.filter((r) => r.change === "improved" || r.change === "new").length;
  const down = rows.filter((r) => r.change === "declined" || r.change === "lost").length;
  if (up && down) return `${capitalize(countOf(up, "keyword"))} moved up and ${countOf(down, "keyword").replace(/ keywords?$/, "")} moved down, compared with ${since}.`;
  if (up) return `${capitalize(countOf(up, "keyword"))} moved up, compared with ${since}.`;
  if (down) return `${capitalize(countOf(down, "keyword"))} moved down, compared with ${since}.`;
  return nothingMoved(startDate);
}

/**
 * A check's results for the runs table. Each keyword gets one first look, so "31 of 31" counts keywords;
 * `rechecks` counts the looks after those, up to two a keyword, so it never counts keywords.
 */
export function runProgress(r: { tasksDone: number; tasksTotal: number; tasksFailed: number; rechecks: number; notChecked: number }): string {
  const looks = r.rechecks ? `, ${formatNumber(r.rechecks)} extra ${r.rechecks === 1 ? "look" : "looks"}` : "";
  return `${r.tasksDone} of ${r.tasksTotal}${r.tasksFailed ? ` (${r.tasksFailed} failed)` : ""}${looks}${r.notChecked ? `, ${r.notChecked} not confirmed` : ""}`;
}

/** The warning above the table. These keywords were looked up; no look found them, so what shows is their last position. */
export function notConfirmedTitle(n: number): string {
  return `${n} ${n === 1 ? "keyword" : "keywords"} not confirmed in the last check`;
}

/** The four numbers the page leads on. */
export function rankFigures(o: Pick<Overview, "start" | "end">): FigureData[] {
  const { start, end } = o;
  const earlier = start && end && start.date !== end.date ? start : null;
  const since = sinceClause(earlier?.date);
  const value = (f: { id: string; label: string; value: string; caption: string; delta: ReturnType<typeof changeDelta> | null; position?: { value: number; previous?: number | null } }): FigureData => ({ state: "value", ...f });
  return [
    value({
      id: "visibility",
      label: "Visibility",
      value: formatPct(end?.visibility),
      delta: earlier?.visibility != null && end?.visibility != null ? changeDelta(end.visibility - earlier.visibility, "points", "up") : null,
      caption: `100% is #1 for every keyword${visibilityNote(end?.visibilityNotConfirmed)}${since}`,
    }),
    value({
      id: "position",
      label: "Tracked position",
      value: end?.avgPosition != null ? end.avgPosition.toFixed(1) : "–",
      delta: earlier?.avgPosition != null && end?.avgPosition != null ? changeDelta(end.avgPosition - earlier.avgPosition, "decimal", "down", true) : null,
      position: end?.avgPosition != null ? { value: end.avgPosition, previous: earlier?.avgPosition } : undefined,
      caption: `${end ? `${formatNumber(end.top100)} ranking` : "average where you rank"}${positionNote(end)}${since}`,
    }),
    value({
      id: "page-one",
      label: "On page one",
      value: end ? `${formatNumber(end.top10)} of ${formatNumber(end.keywords)}` : "–",
      delta: earlier && end ? changeDelta(end.top10 - earlier.top10, "number", "up") : null,
      caption: `in the top 10${end?.top10NotConfirmed ? `, ${formatNumber(end.top10NotConfirmed)} of the ${formatNumber(end.top10)} not confirmed` : ""}${since}`,
    }),
    value({
      id: "traffic",
      label: "Est. traffic / month",
      value: end ? formatNumber(Math.round(end.traffic)) : "–",
      delta: earlier && end ? countDelta(end.traffic, earlier.traffic) : null,
      caption: [trafficNote(end?.trafficNotConfirmed), earlier ? `vs ${chartDay(earlier.date)}` : TRAFFIC_CAPTION].filter(Boolean).join(", "),
    }),
  ];
}

// ─── The sub-pages ───────────────────────────────────────────────────────────────────────────

/** The first and last check a page compares. */
export interface RankWindow {
  start: string;
  end: string;
}

type ValueFigure = Extract<FigureData, { state: "value" }>;

const figure = (f: Omit<ValueFigure, "state" | "delta"> & { delta?: ValueFigure["delta"] }): FigureData => ({ state: "value", delta: null, ...f });

/** Drops the columns in `optional` that hold nothing in any row. Zero counts as nothing: an all-zero traffic column means volumes haven't loaded. */
export function withoutEmptyColumns<C extends { key: string }>(columns: readonly C[], rows: readonly Record<string, unknown>[], optional: readonly string[]): C[] {
  return columns.filter((c) => !optional.includes(c.key) || rows.some((r) => r[c.key] != null && r[c.key] !== "" && r[c.key] !== 0));
}

/**
 * The day a check reads as: the day it started in the workspace's zone. `rank_runs.date` is the UTC
 * day its results are filed under, which stays that way because a keyword's history, day-over-day
 * changes and the once-a-day guard on scheduled checks all key on it.
 */
export const runDay = (startedAt: Date, timeZone: string) => formatTimestamp(startedAt, timeZone).slice(0, 10);

// ─── Competitors ─────────────────────────────────────────────────────────────────────────────

type DomainView = Pick<CompetitorView, "domains" | "start" | "end">;

const share = (m: Map<string, Summary>, domain: string) => m.get(domain)?.shareOfVoice ?? 0;

/** "rival.com", or "two competitors" when naming them all would run on. */
const whoever = (domains: string[]) => (domains.length === 1 ? domains[0] : countOf(domains.length, "competitor"));

/** Who has the most share of voice on the last check: "you", a domain, or nobody when no one has any. */
function leader(v: DomainView, you: string): string | null {
  const mine = share(v.end, you);
  const best = v.domains.filter((d) => d !== you).reduce<string | null>((top, d) => (top == null || share(v.end, d) > share(v.end, top) ? d : top), null);
  if (best != null && share(v.end, best) > mine) return best;
  return mine > 0 ? "you" : null;
}

/** The same view on confirmed positions alone: each share without the part no look confirmed. */
function confirmedShares(v: DomainView): DomainView {
  const strip = (m: Map<string, Summary>) => new Map([...m].map(([d, s]) => [d, { ...s, shareOfVoice: s.shareOfVoice == null ? null : s.shareOfVoice - s.shareOfVoiceNotConfirmed }]));
  return { ...v, start: strip(v.start), end: strip(v.end) };
}

/**
 * Who changed places with you on share of voice leads; otherwise how your own share moved, and who's
 * ahead. When positions no look confirmed would change that, it also says what confirmed ones alone show.
 */
export function competitorSentence(v: DomainView, you: string, win: RankWindow): string {
  const said = sentenceOn(v, you, win);
  const confirmed = confirmedShares(v);
  const alone = sentenceOn(confirmed, you, win);
  if (alone === said) return said;
  let tail: string;
  if (win.start === win.end) {
    const lead = leader(confirmed, you);
    tail = lead === "you" ? "you lead." : lead ? `${lead} leads.` : "no one has a share of voice yet.";
  } else tail = `${alone.charAt(0).toLowerCase()}${alone.slice(1)}`;
  return `${said} That counts positions not confirmed; on confirmed positions alone, ${tail}`;
}

function sentenceOn(v: DomainView, you: string, win: RankWindow): string {
  const rivals = v.domains.filter((d) => d !== you);
  const lead = rivals.length ? leader(v, you) : null;
  const leads = lead === "you" ? "you lead" : `${lead} leads`;
  if (win.start === win.end) {
    if (!lead) return `First check on ${chartDay(win.end)}. Changes show after the next one.`;
    return `First check on ${chartDay(win.end)}, and ${leads} on share of voice so far.`;
  }
  const since = chartDay(win.start);
  const mineThen = share(v.start, you);
  const mineNow = share(v.end, you);
  const passedYou = rivals.filter((d) => share(v.start, d) <= mineThen && share(v.end, d) > mineNow);
  const youPassed = rivals.filter((d) => share(v.start, d) > mineThen && share(v.end, d) <= mineNow);
  if (passedYou.length && youPassed.length) return `You passed ${whoever(youPassed)} and ${whoever(passedYou)} passed you on share of voice, compared with ${since}.`;
  if (passedYou.length) return `${passedYou.length === 1 ? passedYou[0] : capitalize(whoever(passedYou))} passed you on share of voice, compared with ${since}.`;
  if (youPassed.length) return `You passed ${whoever(youPassed)} on share of voice, compared with ${since}.`;

  const tail = lead ? `, and ${leads}` : "";
  const change = mineNow - mineThen;
  if (changeDelta(change, "points", "up").tone !== "muted") return `Your share of voice ${change > 0 ? "rose" : "fell"} ${(Math.abs(change) * 100).toFixed(1)} points since ${since}${tail}.`;
  const othersMoved = rivals.some((d) => changeDelta(share(v.end, d) - share(v.start, d), "points", "up").tone !== "muted");
  if (othersMoved) return `Your share of voice held at ${formatPct(mineNow, 2)} since ${since}${tail}.`;
  return `Nothing moved since ${since}${tail}.`;
}

/** Your numbers on the page's measures, and how many of the sites you watch are ahead. */
export function competitorFigures(v: DomainView, you: string, win: RankWindow, addHref: string): FigureData[] {
  const earlier = win.start !== win.end ? v.start.get(you) : undefined;
  const end = v.end.get(you);
  const since = sinceClause(earlier && win.start);
  const rivals = v.domains.filter((d) => d !== you);
  const ahead = (m: Map<string, Summary>) => rivals.filter((d) => share(m, d) > share(m, you)).length;
  // A keyword no look confirmed repeats its last results page for everyone on it, so the gap to a rival there is an old one.
  const unconfirmed = visibilityNote(end?.visibilityNotConfirmed);
  const gap = unconfirmed && rivals.length ? `${unconfirmed}, so the gap to competitors isn't measured` : unconfirmed;
  const sovNote = pointsNotConfirmed(end?.shareOfVoiceNotConfirmed, 2);
  // Competitors ahead on confirmed positions alone, said only when that count differs.
  const confirmed = confirmedShares(v);
  const aheadConfirmed = ahead(confirmed.end);
  const aheadNote = aheadConfirmed !== ahead(v.end) ? `, ${formatNumber(aheadConfirmed)} on confirmed positions alone` : "";
  return [
    figure({
      id: "share",
      label: "Share of voice",
      value: formatPct(end?.shareOfVoice, 2),
      delta: earlier?.shareOfVoice != null && end?.shareOfVoice != null ? changeDelta(end.shareOfVoice - earlier.shareOfVoice, "points", "up") : null,
      caption: `your share of clicks on these searches${sovNote ? `, ${sovNote}` : ""}${since}`,
    }),
    figure({
      id: "visibility",
      label: "Visibility",
      value: formatPct(end?.visibility),
      delta: earlier?.visibility != null && end?.visibility != null ? changeDelta(end.visibility - earlier.visibility, "points", "up") : null,
      caption: `100% is #1 for every keyword${gap}${since}`,
    }),
    end?.avgPosition != null
      ? figure({
          id: "position",
          label: "Tracked position",
          value: end.avgPosition.toFixed(1),
          delta: earlier?.avgPosition != null ? changeDelta(end.avgPosition - earlier.avgPosition, "decimal", "down", true) : null,
          position: { value: end.avgPosition, previous: earlier?.avgPosition },
          caption: `${formatNumber(end.top100)} ranking${positionNote(end)}${since}`,
        })
      : { id: "position", label: "Tracked position", state: "empty", text: "Not in the results checked" },
    rivals.length
      ? figure({
          id: "ahead",
          label: "Competitors ahead",
          value: `${ahead(v.end)} of ${rivals.length}`,
          delta: earlier ? changeDelta(ahead(v.end) - ahead(v.start), "number", "down") : null,
          caption: `on share of voice${aheadNote}${since}`,
        })
      : { id: "ahead", label: "Competitors ahead", state: "empty", text: "None added yet", action: { label: "Add competitors", href: addHref } },
  ];
}

export interface CompetitorRow extends Record<string, unknown> {
  domain: string;
  /** The domain as the table names it, "site.com (you)" for the project. */
  label: string;
  isYou: boolean;
  shareOfVoice: number | null;
  shareChange: number | null;
  shareDelta: ValueFigure["delta"];
  visibility: number | null;
  visibilityChange: number | null;
  visibilityDelta: ValueFigure["delta"];
  traffic: number;
  avgPosition: number | null;
  top3: number;
  top10: number;
  top100: number;
  /** "4 of 12": how many tracked keywords the domain ranks for. */
  ranking: string;
}

/** The tracked domains on the last check, most share of voice first, with change since the first check. */
export function competitorRows(v: DomainView, you: string, win: RankWindow): CompetitorRow[] {
  const compare = win.start !== win.end;
  const change = (now: number | null, then: number | null | undefined) => (compare ? (now ?? 0) - (then ?? 0) : null);
  return v.domains
    .map((domain): CompetitorRow => {
      const e = v.end.get(domain)!;
      const s = v.start.get(domain);
      const shareChange = change(e.shareOfVoice, s?.shareOfVoice);
      const visibilityChange = change(e.visibility, s?.visibility);
      return {
        domain,
        label: domain === you ? `${domain} (you)` : domain,
        isYou: domain === you,
        shareOfVoice: e.shareOfVoice,
        shareChange,
        shareDelta: shareChange == null ? null : changeDelta(shareChange, "points", "up"),
        visibility: e.visibility,
        visibilityChange,
        visibilityDelta: visibilityChange == null ? null : changeDelta(visibilityChange, "points", "up"),
        traffic: e.traffic,
        avgPosition: e.avgPosition,
        top3: e.top3,
        top10: e.top10,
        top100: e.top100,
        ranking: `${e.top100} of ${e.keywords}`,
      };
    })
    .sort((a, b) => (b.shareOfVoice ?? 0) - (a.shareOfVoice ?? 0));
}

// ─── Pages ───────────────────────────────────────────────────────────────────────────────────

type DroppedPage = { url: string; keywords: number };

/** "/services/roofing", cut short so it fits under a figure. */
function shortPath(url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "") || "/";
  return path.length > 28 ? `${path.slice(0, 27)}…` : path;
}

/** Which pages gained or lost keywords across the window. A page that fell out altogether counts as losing them. */
export function pagesSentence(pages: Pick<PageRow, "keywordsDelta">[], dropped: DroppedPage[], win: RankWindow): string {
  if (win.start === win.end || pages.every((p) => p.keywordsDelta == null)) {
    const n = pages.length;
    return `${capitalize(countOf(n, "page"))} rank${n === 1 ? "s" : ""} for your tracked keywords on ${chartDay(win.end)}. Changes show after the next check.`;
  }
  const since = chartDay(win.start);
  const gained = pages.filter((p) => (p.keywordsDelta ?? 0) > 0).length;
  const lost = pages.filter((p) => (p.keywordsDelta ?? 0) < 0).length + dropped.length;
  if (gained && lost) return `${capitalize(countOf(gained, "page"))} gained keywords and ${countWord(lost)} lost some, compared with ${since}.`;
  if (gained) return `${capitalize(countOf(gained, "page"))} gained keywords, compared with ${since}.`;
  if (lost) return `${capitalize(countOf(lost, "page"))} lost keywords, compared with ${since}.`;
  return `Every page ranks for the same number of keywords as on ${since}.`;
}

export function pagesFigures(pages: Pick<PageRow, "url" | "keywords" | "keywordsDelta" | "traffic">[], dropped: DroppedPage[], win: RankWindow): FigureData[] {
  const compare = win.start !== win.end && pages.some((p) => p.keywordsDelta != null);
  const since = sinceClause(compare ? win.start : null);
  const keywords = pages.reduce((n, p) => n + p.keywords, 0);
  const traffic = pages.reduce((n, p) => n + p.traffic, 0);
  const fresh = pages.filter((p) => p.keywordsDelta != null && p.keywords === p.keywordsDelta).length;
  const pagesBefore = pages.length - fresh + dropped.length;
  const keywordsBefore = keywords - pages.reduce((n, p) => n + (p.keywordsDelta ?? 0), 0) + dropped.reduce((n, p) => n + p.keywords, 0);
  const out: FigureData[] = [
    figure({ id: "pages", label: "Ranking pages", value: formatNumber(pages.length), delta: compare ? countDelta(pages.length, pagesBefore) : null, caption: compare ? `vs ${chartDay(win.start)}` : "in your tracked results" }),
    figure({ id: "keywords", label: "Keywords ranking", value: formatNumber(keywords), delta: compare ? countDelta(keywords, keywordsBefore) : null, caption: `across these pages${since}` }),
    figure({ id: "traffic", label: "Est. traffic / month", value: formatNumber(Math.round(traffic)), caption: TRAFFIC_CAPTION }),
  ];
  // Sorted by traffic, so the first page is the top one.
  if (traffic > 0 && pages[0]) out.push(figure({ id: "top", label: "Top page", value: formatPct(pages[0].traffic / traffic, 0), caption: `of that traffic: ${shortPath(pages[0].url)}` }));
  return out;
}

// ─── Competing pages ─────────────────────────────────────────────────────────────────────────

const across = (win: RankWindow) => (win.start === win.end ? `on ${chartDay(win.end)}` : `${chartDay(win.start)} to ${chartDay(win.end)}`);

/** How many ranking keywords have your own pages competing in the window. The list has no earlier reading to compare, so it says where things stand. */
export function cannibalSentence(affected: number, ranking: number, win: RankWindow): string {
  if (!ranking) return `None of your tracked keywords ranked ${win.start === win.end ? "" : "from "}${across(win)}, so none of your pages are competing.`;
  if (!affected) return `None of your ${countOf(ranking, "ranking keyword")} had two of your pages competing, ${across(win)}.`;
  return `${capitalize(countWord(affected))} of ${countOf(ranking, "ranking keyword")} had two or more of your pages competing, ${across(win)}.`;
}

export function cannibalFigures(affected: Pick<CannibalRow, "volume">[], ranking: number, pagesInvolved: number, rankingPages: number): FigureData[] {
  return [
    figure({ id: "affected", label: "Affected keywords", value: `${affected.length} of ${ranking}`, caption: "of keywords that rank" }),
    figure({ id: "clear", label: "Without a conflict", value: ranking ? formatPct(1 - affected.length / ranking, 0) : "–", caption: "of ranking keywords" }),
    figure({ id: "pages", label: "Pages involved", value: `${pagesInvolved} of ${rankingPages}`, caption: "of your ranking pages" }),
    figure({ id: "volume", label: "Volume at stake", value: formatNumber(affected.reduce((n, a) => n + (a.volume ?? 0), 0)), caption: "monthly searches" }),
  ];
}

// ─── One keyword ─────────────────────────────────────────────────────────────────────────────

/** A check as the page reads it, through `carryDeepPositions`. */
export interface KeywordReading {
  date: string;
  position: number | null;
  depth: number;
  notChecked: boolean;
  deeperCheckDate: string | null;
  checkedAt: Date;
}

/**
 * How the keyword moved between the first and last check in the range. Reaching or leaving page one
 * leads. A position no look confirmed is only its last sighting, so that's all the sentence says of it.
 */
export function keywordSentence(read: Pick<KeywordReading, "date" | "position" | "depth" | "notChecked" | "checkedAt">[], searchConsole?: number | null): string {
  const first = read[0];
  const now = read[read.length - 1];
  if (!now) return "No checks in this range. Results appear after the next one.";
  const day = chartDay(now.date);
  if (now.notChecked && now.position != null) {
    return `Last seen at position ${now.position} on ${chartDay(now.checkedAt.toISOString())}. The ${day} check didn't find it on any look, so that position isn't confirmed.`;
  }
  if (now.position == null && searchConsole != null && searchConsole <= now.depth) {
    return `Not found in the top ${now.depth} on ${day}, but Search Console has it around ${searchConsole.toFixed(1)} across every location, so this check may have missed it.`;
  }
  if (first === now) return now.position != null ? `One check in this range: position ${now.position} on ${day}.` : `One check in this range: not in the top ${now.depth} on ${day}.`;
  const since = chartDay(first.date);
  const [a, b] = [first.position, now.position];
  if (a == null && b == null) return `Still not in the top ${now.depth}, as on ${since}.`;
  if (a == null) return onPageOne(b) ? `On page one at position ${b}, after not being found on ${since}.` : `Now at position ${b}, after not being found on ${since}.`;
  if (b == null) return onPageOne(a) ? `Fell off page one and out of the top ${now.depth}, from position ${a} on ${since}.` : `Dropped out of the top ${now.depth}, from position ${a} on ${since}.`;
  if (a === b) return `Held position ${b} since ${since}.`;
  if (!onPageOne(a) && onPageOne(b)) return `Reached page one at position ${b}, up from ${a} on ${since}.`;
  if (onPageOne(a) && !onPageOne(b)) return `Fell off page one to position ${b}, down from ${a} on ${since}.`;
  return `${b < a ? "Up" : "Down"} from ${a} to ${b} since ${since}.`;
}

/**
 * A tracked keyword's search volume, with the place it's for: the project's city from Google Ads when it
 * tracks one, else its country. Keyword research shows the country's, so this says which it is.
 */
export function keywordVolume(volume: number | null, place: string): string {
  return volume == null ? `no search volume on record in ${place}` : `${formatNumber(volume)} searches a month in ${place}`;
}

/** A stored check as the keyword page shows it. A not-checked row repeats an earlier one, `checkedAt` included. */
type StoredCheck = { date: string; notChecked: boolean; checkedAt: Date; depth: number; seResultsCount: number | null };

/** When the keyword page's results are from: the check's time, or for a row no look confirmed, when they were last seen. */
export function keywordCheckedLabel(latest: Pick<StoredCheck, "date" | "notChecked" | "checkedAt">, timeZone: string): string {
  const at = formatDateTimeZoned(latest.checkedAt, timeZone);
  return latest.notChecked ? `last seen ${at}, not confirmed on ${formatDay(latest.date)}` : `checked ${at}`;
}

/** The words above Google results for one check. A row no look confirmed shows the results it repeats, and says so. */
export function googleResultsDescription(snap: StoredCheck, timeZone: string): string {
  const at = formatDateTimeZoned(snap.checkedAt, timeZone);
  if (snap.notChecked) return `${formatDay(snap.date)} isn't confirmed: no look that day found this keyword's result, so these are the results last seen ${at}, looking at the top ${snap.depth}. First 20 items.`;
  return `${formatDay(snap.date)}, checked ${at}, looking at the top ${snap.depth}.${snap.seResultsCount != null ? ` ${formatNumber(snap.seResultsCount)} results.` : ""} First 20 items.`;
}

/** One row of Check history. `seen` marks a row that repeats an earlier check's results, so they don't read as that day's. */
export function checkHistoryRow(h: StoredCheck & { position: number | null; url: string | null; serpFeatures: string[]; aiOverviewLoaded: boolean | null; aiOverview: boolean; aiOverviewCited: boolean; ownUrls: unknown[] }) {
  return {
    date: h.date,
    position: h.position,
    seen: h.notChecked ? "not confirmed" : "",
    url: h.url,
    depth: h.depth,
    features: h.serpFeatures.map(featureLabel).join(", "),
    aio: !h.aiOverviewLoaded ? "" : h.aiOverviewCited ? "cited" : h.aiOverview ? "not cited" : "",
    urls: h.ownUrls.length,
  };
}

/** Under this many checks your own numbers say more than a chart would, by the chart-or-number rule. */
const LINES_FROM = 4;

/**
 * What Position history shows and the words above it, by the rule the charts themselves draw by. Competitors
 * come in once their lines have earned a chart. Otherwise it's your own reading, which may be only words, so
 * nothing talks about the top of a chart that isn't there.
 */
export function positionHistory(yours: SeriesPoint[], rivals: SeriesPoint[][]): { withRivals: boolean; description: string } {
  if (rivals.length > 0 && yours.length >= LINES_FROM && chooseLines([yours, ...rivals], { misses: true }).kind === "chart") {
    return { withRivals: true, description: "You and your competitors in the same Google results. #1 is at the top." };
  }
  const drawn = chooseChart(yours, { misses: true }).kind === "line";
  return { withRivals: false, description: drawn ? "Where you ranked at each check. #1 is at the top." : "Where you ranked at each check." };
}

/** Where the position figure's number came from, when it isn't simply today's check. */
function readFrom(now: KeywordReading): string {
  if (now.deeperCheckDate) return `from the deeper check on ${chartDay(now.deeperCheckDate)}`;
  if (now.notChecked) return `last seen ${chartDay(now.checkedAt.toISOString())}, not confirmed on ${chartDay(now.date)}`;
  return `on ${chartDay(now.date)}, top ${now.depth} checked`;
}

export function keywordFigures(read: KeywordReading[], best: number | null, ai: { date: string; aiOverview: boolean; aiOverviewCited: boolean } | null, range: number): FigureData[] {
  const first = read[0];
  const now = read[read.length - 1];
  const earlier = first && first !== now ? first : null;
  const position: FigureData = !now
    ? { id: "position", label: "Tracked position", state: "empty", text: "Not checked in this range" }
    : now.position == null
      ? { id: "position", label: "Tracked position", state: "empty", text: `Not in the top ${now.depth} on ${chartDay(now.date)}` }
      : figure({
          id: "position",
          label: "Tracked position",
          value: String(now.position),
          // A position no look confirmed shows no move, as on Rankings.
          delta: earlier?.position != null && !now.notChecked ? changeDelta(now.position - earlier.position, "number", "down", true) : null,
          position: { value: now.position, previous: now.notChecked ? undefined : earlier?.position },
          caption: earlier?.position != null && !now.notChecked ? `${readFrom(now)}, vs ${chartDay(earlier.date)}` : readFrom(now),
        });
  return [
    position,
    best != null ? figure({ id: "best", label: "Best position", value: String(best), caption: `in the last ${range} days` }) : { id: "best", label: "Best position", state: "empty", text: `Not found in the last ${range} days` },
    ai
      ? figure({ id: "ai", label: "AI Overview", value: ai.aiOverviewCited ? "Cited" : ai.aiOverview ? "Not cited" : "None", caption: `weekly check of ${chartDay(ai.date)}` })
      : { id: "ai", label: "AI Overview", state: "empty", text: "No weekly check in this range" },
  ];
}
