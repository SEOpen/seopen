/** The top of the AI visibility pages, from stored answers. Pure, so it's tested and costs nothing. */
import type { FigureData } from "@/components/ui/figure";
import { chartDay, magnitude } from "@/components/ui/module-card";
import type { ChartRow, ChartSeries } from "@/components/ui/time-chart";
import { briefSentence, changeDelta, countDelta, countOf, countWord, MIN_WEIGHT, type Move } from "@/lib/brief";
import { locationName, trackedPlaceName } from "@/lib/dataforseo/locations";
import { formatNumber, formatPct, formatUsd } from "@/lib/format";
import type { PromptTableRow } from "./components/prompt-table";
import type { Overview } from "./data";
import { deltaPoints } from "./metrics";
import { roundUsd } from "./prompts";
import type { Ownership } from "./sources";

/** Below this many answers a percentage overstates a move, so the sentence counts answers instead. */
const SMALL = 20;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const list = (items: string[]) => new Intl.ListFormat("en-US", { type: "conjunction" }).format(items);

const plural = (n: number, noun: string) => `${formatNumber(n)} ${n === 1 ? noun : `${noun}s`}`;

type Value = Extract<FigureData, { state: "value" }>;
const value = (f: Omit<Value, "state" | "delta"> & { delta?: Value["delta"] }): FigureData => ({ state: "value", delta: null, ...f });

/** How far the AI Overview numbers reach. `total` is the tracked prompts with a keyword; a new one waits for the next weekly check. */
export function aioCoverage(checked: number, total: number): string | null {
  return checked >= total ? null : `${formatNumber(checked)} of ${plural(total, "keyword")} checked so far. The others are checked with the next weekly run.`;
}

/** How the Overview says the Free plan won't ask these prompts, so nothing is on its way. */
export const AI_NOT_ON_FREE = "not checked on the Free plan";

/** Prompts with no answers yet, as the Overview reads it: "3 prompts tracked, waiting for the first run". Free asks none. */
export function waitingOnFirstRun(prompts: number, free: boolean): string {
  return `${prompts} prompt${prompts === 1 ? "" : "s"} tracked, ${free ? AI_NOT_ON_FREE : "waiting for the first run"}`;
}

/**
 * The Prompts tab's header line. `monthlyUsd`: the cost at the weekly schedule, null where costs don't
 * show. Free asks no AI questions, so it promises no weekly check.
 */
export function promptsDescription(active: number, { free, monthlyUsd }: { free: boolean; monthlyUsd: number | null }): string {
  const count = `${active} active prompt${active === 1 ? "" : "s"}`;
  if (free) return `${count} · ${AI_NOT_ON_FREE}`;
  return `${count} · ${monthlyUsd != null ? `≈ ${formatUsd(roundUsd(monthlyUsd))}/month at the weekly schedule, the mentions check included` : "checked weekly"}`;
}

/**
 * Where and how often the AI Overview check looks, beside Rankings' own look at the same SERP feature. The
 * check searches the project's country on desktop once a week (`postAioTasks`); Rankings searches its tracked
 * place, the city when one is set, every day. So a keyword can show an AI Overview on Rankings and none here.
 */
export function aioSource(project: { locationCode: number; cityCode: number | null; cityName: string | null }): string {
  const rankPlace = project.cityCode ? ` (${trackedPlaceName(project)})` : "";
  return `Weekly check of each prompt's keyword form on Google (desktop, ${locationName(project.locationCode)}). Rankings looks at its keywords daily${rankPlace}, and AI Overviews come and go, so the two can differ.`;
}

/** The day of a run, counted back from the latest: 1 is the latest, 2 the one before. */
function runDay(o: Pick<Overview, "trend">, back: number): string | null {
  const date = o.trend.at(-back)?.date;
  return typeof date === "string" ? chartDay(date) : null;
}

type Totals = Pick<Overview["current"], "total" | "mentioned" | "cited" | "score" | "citedRate">;

/** One rate's move: in answers when both runs are small and the same size, in points otherwise. */
function answerMove(verb: "name" | "cite", noun: string, now: Totals, before: Totals): Move | null {
  const [count, was, rate, wasRate] = verb === "name" ? [now.mentioned, before.mentioned, now.score, before.score] : [now.cited, before.cited, now.citedRate, before.citedRate];
  if (now.total === before.total && now.total < SMALL) {
    const diff = count - was;
    if (!diff) return null;
    const n = Math.abs(diff);
    return {
      clause: `${countWord(n)} ${diff > 0 ? "more" : "fewer"} ${n === 1 ? `answer ${verb}s` : `answers ${verb}`} you`,
      tone: diff > 0 ? "good" : "bad",
      weight: MIN_WEIGHT + n / now.total,
    };
  }
  const points = deltaPoints(rate, wasRate);
  if (!points) return null;
  // Worded from the figure's own rounding, so the sentence and the number under it can't disagree.
  const size = magnitude(Math.abs(rate! - wasRate!), "points").replace(/ pts?$/, "");
  if (!/[1-9]/.test(size)) return null;
  return { clause: `${noun} is ${points > 0 ? "up" : "down"} ${size} ${size === "1" ? "point" : "points"}`, tone: points > 0 ? "good" : "bad", weight: MIN_WEIGHT + Math.abs(points) / 100 };
}

const failedNote = (failed = 0) => (failed ? ` · ${formatNumber(failed)} failed` : "");

/** One platform's count on /ai. An answer that failed isn't an answer that didn't name you, so it's said beside the count, not in it. */
export function platformCount(p: Pick<Overview["current"], "mentioned" | "total">, failed = 0): string {
  return `${p.total ? `${p.mentioned} of ${p.total} answers` : "No answers"}${failedNote(failed)}`;
}

/** What moved since the run before: how often answers name you, and how often they link to you. */
export function aiSentence(o: Pick<Overview, "current" | "previous" | "trend"> & Partial<Pick<Overview, "failed" | "failedRun">>): string {
  const { current, previous, failed, failedRun } = o;
  if (!current.total) return "Waiting for the first run.";
  if (!previous) {
    const counted = `${current.mentioned} of ${current.total} answers ${current.mentioned === 1 ? "names" : "name"} you`;
    const day = runDay(o, 1);
    const andFailed = failed ? `, and ${formatNumber(failed)} failed` : "";
    // The run before's answers against the one before that would read as this week's change.
    if (failedRun) return `No answers came back from the ${chartDay(failedRun)} run, so there's no change to report. These are the ${day ?? "earlier"} answers: ${counted}${andFailed}.`;
    return `${day ? `First run on ${day}` : "First run"}: ${counted}${andFailed}. Changes show after the next one.`;
  }
  const day = runDay(o, 2);
  const moves = [answerMove("name", "visibility", current, previous), answerMove("cite", "the share of answers citing you", current, previous)].filter((m): m is Move => !!m);
  const sentence = briefSentence(moves, "");
  if (!sentence) return day ? `Nothing moved since ${day}.` : "Nothing moved since the run before.";
  return `${sentence.slice(0, -1)}, compared with ${day ?? "the run before"}.`;
}

/** Why the latest run has no position. "Yet" is only true on the first run: later ones can't speak for all the runs before. */
function noPosition(current: Overview["current"], previous: Overview["previous"], day: string | null, failedRun = false): string {
  if (current.mentioned) return "The latest answers name you without a position.";
  if (previous?.avgPosition != null) return `Not named in the latest run. You were at ${previous.avgPosition.toFixed(1)} ${day ? `on ${day}` : "in the run before"}.`;
  // No `previous` because the newest run got nothing back, not because there was no run before.
  if (failedRun) return "Not named in the latest answers.";
  return previous ? "Not named in the latest run." : "Not named in any answer yet.";
}

/**
 * The four numbers /ai leads on. `competitorsHref` is where a project with none goes to add one. A rate
 * moves in points; position always reads better or worse.
 */
export function aiFigures(o: Pick<Overview, "current" | "previous" | "sov" | "previousSov" | "trend"> & Partial<Pick<Overview, "failed" | "failedRun">>, competitorsHref: string): FigureData[] {
  const { current, previous, sov, previousSov } = o;
  const day = previous ? runDay(o, 2) : null;
  // On one run the sentence above already says changes show after the next, so the captions just describe their numbers.
  const since = previous ? `, vs ${day ?? "the run before"}` : "";
  const points = (now: number | null | undefined, before: number | null | undefined) => (now != null && before != null ? changeDelta(now - before, "points", "up") : null);
  const own = sov.find((s) => s.own);
  const ownBefore = previousSov?.find((s) => s.own);
  const rivals = sov.length - 1;
  return [
    value({
      id: "visibility",
      label: "Visibility",
      value: formatPct(current.score),
      delta: points(current.score, previous?.score),
      caption: `${current.mentioned} of ${current.total} answers ${current.mentioned === 1 ? "names" : "name"} you${failedNote(o.failed)}${since}`,
    }),
    value({
      id: "cited",
      label: "Cited",
      value: formatPct(current.citedRate),
      delta: points(current.citedRate, previous?.citedRate),
      caption: `${current.cited} ${current.cited === 1 ? "answer links" : "answers link"} to you${since}`,
    }),
    rivals > 0
      ? value({
          id: "share-of-voice",
          label: "Share of voice",
          value: formatPct(own?.sov ?? null),
          delta: points(own?.sov, ownBefore?.sov),
          caption: `against ${plural(rivals, "competitor")}${since}`,
        })
      : { id: "share-of-voice", label: "Share of voice", state: "empty", text: "Needs a competitor to compare against.", action: { label: "Add a competitor", href: competitorsHref } },
    current.avgPosition == null
      ? { id: "position", label: "Position when named", state: "empty", text: noPosition(current, previous, day, !!o.failedRun) }
      : value({
          id: "position",
          label: "Position when named",
          value: current.avgPosition.toFixed(1),
          delta: previous?.avgPosition != null ? changeDelta(current.avgPosition - previous.avgPosition, "decimal", "down", true) : null,
          caption: `1 is named first${since}`,
        }),
  ];
}

/**
 * The run-by-run chart: you, then every competitor that's been named at least once, drawn on a real time
 * scale. The run's wall clock in the workspace's zone goes in as UTC, so the ruler's days and the hover's
 * times read the same for everyone. Competitors never named are counted, not drawn: six lines on zero say nothing.
 */
export function trendChart(o: Pick<Overview, "brands" | "trend">): { rows: ChartRow[]; series: ChartSeries[]; neverNamed: number } {
  const rivals = o.brands.filter((b) => !b.own);
  const named = rivals.filter((b) => o.trend.some((p) => typeof p[b.domain] === "number" && (p[b.domain] as number) > 0));
  const rows = o.trend.map((p) => {
    const date = `${String(p.date).replace(" ", "T")}Z`;
    const row: ChartRow = {
      date,
      label: new Date(date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }),
      visibility: p.visibility,
    };
    for (const b of named) row[b.domain] = p[b.domain] as number | null;
    return row;
  });
  const series: ChartSeries[] = [{ key: "visibility", label: "You" }, ...named.map((b) => ({ key: b.domain, label: b.name, role: "context" as const }))];
  return { rows, series, neverNamed: rivals.length - named.length };
}

// ─── Prompts ────────────────────────────────────────────────────────────────────────────────────

type PromptRow = Pick<PromptTableRow, "active" | "branded" | "mentionedOn" | "citedOn" | "checkedOn">;

/**
 * Where the tracked prompts stand. A prompt that names your brand gets named almost by definition, so
 * the count leaves those out when there's anything else to count.
 */
export function promptsSentence(rows: PromptRow[]): string {
  if (!rows.length) return "No prompts yet.";
  const active = rows.filter((r) => r.active);
  if (!active.length) return "Every prompt is paused, so nothing is being asked.";
  const asked = active.filter((r) => r.checkedOn > 0);
  if (!asked.length) return `${capitalize(countOf(active.length, "prompt"))} waiting for the first run.`;
  const open = asked.filter((r) => !r.branded);
  const counted = open.length ? open : asked;
  const named = counted.filter((r) => r.mentionedOn > 0).length;
  const scope = open.length && open.length < asked.length ? `${counted.length} ${counted.length === 1 ? "prompt that doesn't" : "prompts that don't"} name your brand` : `${counted.length} ${counted.length === 1 ? "prompt" : "prompts"}`;
  const first = named ? `At least one assistant names you for ${named} of ${scope}.` : `No assistant names you yet across ${scope}.`;
  const waiting = active.length - asked.length;
  return waiting ? `${first} ${capitalize(countOf(waiting, "prompt"))} ${waiting === 1 ? "is" : "are"} waiting for a first answer.` : first;
}

export function promptsFigures(rows: PromptRow[]): FigureData[] {
  const active = rows.filter((r) => r.active);
  const asked = active.filter((r) => r.checkedOn > 0);
  const paused = rows.length - active.length;
  const branded = active.filter((r) => r.branded).length;
  const of = (n: number) => `${formatNumber(n)} of ${formatNumber(asked.length)}`;
  return [
    value({ id: "active", label: "Active prompts", value: formatNumber(active.length), caption: `${formatNumber(branded)} branded, ${formatNumber(paused)} paused` }),
    value({ id: "named", label: "Named", value: of(asked.filter((r) => r.mentionedOn > 0).length), caption: "prompts where an assistant names you" }),
    value({ id: "cited", label: "Cited", value: of(asked.filter((r) => r.citedOn > 0).length), caption: "prompts where an answer links to you" }),
    value({ id: "waiting", label: "No answer yet", value: formatNumber(active.length - asked.length), caption: "active prompts waiting for a run" }),
  ];
}

// ─── One prompt ─────────────────────────────────────────────────────────────────────────────────

/** A finished answer to one prompt, shaped by the page so this file needs no time zone. */
export interface PromptAnswer {
  /** The assistant's name. */
  platform: string;
  /** "Nov 2", in the workspace's zone. */
  day: string;
  named: boolean;
  cited: boolean;
  position: number | null;
  /** Nothing came back, so whether it names you is unknown. */
  failed?: boolean;
}

/**
 * The latest answer per assistant and the one before it. `answers` runs newest first. An assistant whose
 * latest answer failed is left out, since its older answer isn't this run's, and an older failure is
 * passed over for the answer before it.
 */
function answerPairs(answers: PromptAnswer[]) {
  const pairs = new Map<string, { latest: PromptAnswer; before: PromptAnswer | null }>();
  const seen = new Set<string>();
  for (const a of answers) {
    if (!seen.has(a.platform)) {
      seen.add(a.platform);
      if (!a.failed) pairs.set(a.platform, { latest: a, before: null });
      continue;
    }
    const pair = pairs.get(a.platform);
    if (pair && !a.failed) pair.before ??= a;
  }
  return [...pairs.values()];
}

/** How many assistants' latest answer failed. */
const failedLatest = (answers: PromptAnswer[]) => new Set(answers.map((a) => a.platform)).size - answerPairs(answers).length;

function turned(pairs: ReturnType<typeof answerPairs>, read: (a: PromptAnswer) => boolean) {
  const paired = pairs.filter((p): p is { latest: PromptAnswer; before: PromptAnswer } => !!p.before);
  return {
    started: paired.filter((p) => read(p.latest) && !read(p.before)).map((p) => p.latest.platform),
    stopped: paired.filter((p) => !read(p.latest) && read(p.before)).map((p) => p.latest.platform),
  };
}

const turnClause = ({ started, stopped }: { started: string[]; stopped: string[] }, doing: string) => {
  if (started.length && stopped.length) return `${list(started)} started ${doing} you and ${list(stopped)} stopped`;
  return started.length ? `${list(started)} started ${doing} you` : stopped.length ? `${list(stopped)} stopped ${doing} you` : null;
};

/** Which assistants changed their answer since the run before. Being named leads, then being cited. */
export function promptSentence(answers: PromptAnswer[], active = true): string {
  const pairs = answerPairs(answers);
  if (!pairs.length && answers.length) return "The latest answers failed, so there's nothing to compare.";
  if (!pairs.length) return active ? "No answers yet. This prompt is asked in the next run." : "This prompt is paused, and has no answers yet.";
  const earlier = pairs.find((p) => p.before)?.before;
  if (!earlier) {
    const named = pairs.filter((p) => p.latest.named).length;
    return `First answers on ${pairs[0].latest.day}: ${named} of ${pairs.length} ${pairs.length === 1 ? "assistant" : "assistants"} ${named === 1 ? "names" : "name"} you. Changes show after the next run.`;
  }
  const clause = turnClause(turned(pairs, (a) => a.named), "naming") ?? turnClause(turned(pairs, (a) => a.cited), "citing");
  return clause ? `${clause}, compared with ${earlier.day}.` : `Nothing moved since ${earlier.day}.`;
}

/** The prompt's latest AI Overview check, shaped by the page. Null when there's none stored. */
export interface PromptOverview {
  present: boolean;
  cited: boolean;
  keyword: string;
  day: string;
}

export function promptFigures(answers: PromptAnswer[], overview: PromptOverview | null, hasKeyword: boolean): FigureData[] {
  const pairs = answerPairs(answers);
  const paired = pairs.filter((p): p is { latest: PromptAnswer; before: PromptAnswer } => !!p.before);
  // On first answers the sentence above already says changes show after the next run.
  const since = paired.length ? `, vs ${paired[0].before.day}` : "";
  const count = (read: (a: PromptAnswer) => boolean) => pairs.filter((p) => read(p.latest)).length;
  const move = (read: (a: PromptAnswer) => boolean) =>
    paired.length
      ? countDelta(
          paired.filter((p) => read(p.latest)).length,
          paired.filter((p) => read(p.before)).length,
        )
      : null;
  const placed = (a: PromptAnswer) => a.named && a.position != null;
  const mean = (latest: PromptAnswer[]) => {
    const found = latest.filter(placed).map((a) => a.position!);
    return found.length ? found.reduce((a, b) => a + b, 0) / found.length : null;
  };
  const position = mean(pairs.map((p) => p.latest));
  // The change reads only assistants placed in both runs, so one that's new or newly names you can't look like a move.
  const placedTwice = paired.filter((p) => placed(p.latest) && placed(p.before));
  const positionNow = mean(placedTwice.map((p) => p.latest));
  const positionBefore = mean(placedTwice.map((p) => p.before));
  return [
    value({ id: "named", label: "Named by", value: `${count((a) => a.named)} of ${pairs.length}`, delta: move((a) => a.named), caption: `assistants in the latest answers${failedNote(failedLatest(answers))}${since}` }),
    value({ id: "cited", label: "Cited by", value: `${count((a) => a.cited)} of ${pairs.length}`, delta: move((a) => a.cited), caption: `assistants linking to you${since}` }),
    position == null
      ? { id: "position", label: "Position when named", state: "empty", text: "Not named in the latest answers." }
      : value({
          id: "position",
          label: "Position when named",
          value: position.toFixed(1),
          delta: positionNow != null && positionBefore != null ? changeDelta(positionNow - positionBefore, "decimal", "down", true) : null,
          caption: `1 is named first${since}`,
        }),
    overview
      ? value({ id: "overview", label: "Google AI Overview", value: !overview.present ? "None" : overview.cited ? "Cites you" : "Shown", caption: `for “${overview.keyword}”, ${overview.day}` })
      : { id: "overview", label: "Google AI Overview", state: "empty", text: hasKeyword ? "Not checked yet. It's checked with the next run." : "No keyword set, so it isn't checked." },
  ];
}

// ─── Sources ────────────────────────────────────────────────────────────────────────────────────

type SourceRow = { ownership: Ownership; citations: number; withoutUs: number };

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${countWord(n)} times`);

const citations = (rows: SourceRow[], ownership: Ownership) => rows.filter((r) => r.ownership === ownership).reduce((n, r) => n + r.citations, 0);

const outreach = (rows: SourceRow[]) => rows.filter((r) => r.ownership === "third_party" && r.withoutUs > 0).length;

/** Who the answers lean on, and where you're missing. There's one stored reading of this, so nothing to compare. */
export function sourcesSentence({ answers, domains }: { answers: number; domains: SourceRow[] }): string {
  if (!domains.length) return "No answer cites a site yet.";
  const yours = citations(domains, "yours");
  const open = outreach(domains);
  const you = yours ? `Your site is cited ${times(yours)}` : "Your site isn't cited yet";
  const counted = `The latest ${answers === 1 ? "answer cites" : `${formatNumber(answers)} answers cite`} ${countOf(domains.length, "site")}.`;
  return open ? `${counted} ${you}, and ${countOf(open, "third-party site")} ${open === 1 ? "appears" : "appear"} in answers that don't name you.` : `${counted} ${you}.`;
}

export function sourcesFigures({ answers, domains }: { answers: number; domains: SourceRow[] }): FigureData[] {
  const total = domains.reduce((n, r) => n + r.citations, 0);
  return [
    value({ id: "sites", label: "Sites cited", value: formatNumber(domains.length), caption: `in the latest ${plural(answers, "answer")}` }),
    value({ id: "yours", label: "Citing you", value: formatNumber(citations(domains, "yours")), caption: `of ${plural(total, "citation")}` }),
    value({ id: "competitors", label: "Citing competitors", value: formatNumber(citations(domains, "competitor")), caption: `of ${plural(total, "citation")}` }),
    value({ id: "outreach", label: "Worth reaching out to", value: formatNumber(outreach(domains)), caption: "third-party sites in answers that don't name you" }),
  ];
}

// ─── Brands ─────────────────────────────────────────────────────────────────────────────────────

type BrandsInput = { competitors: number; aliases: number; answers: number; suggestions: number };

/** What's being looked for, and whether the answers point at anyone who's missing. */
export function brandsSentence({ competitors, answers, suggestions }: BrandsInput): string {
  const tracked = competitors ? `SEOpen looks for you and ${countOf(competitors, "competitor")} in AI answers.` : "SEOpen looks for you in AI answers, with no competitors yet.";
  if (!answers) return `${tracked} Suggestions appear once tracked prompts have been answered.`;
  if (!suggestions) return `${tracked} No untracked site is cited often enough to suggest.`;
  return `${tracked} ${capitalize(countOf(suggestions, "more site"))} ${suggestions === 1 ? "is" : "are"} cited often enough to consider.`;
}

export function brandsFigures({ competitors, aliases, answers, suggestions }: BrandsInput): FigureData[] {
  return [
    value({ id: "brands", label: "Tracked brands", value: formatNumber(competitors + 1), caption: `you and ${plural(competitors, "competitor")}` }),
    value({ id: "aliases", label: "Aliases", value: formatNumber(aliases), caption: "extra names and domains" }),
    value({ id: "suggested", label: "Suggested competitors", value: formatNumber(suggestions), caption: `cited in two or more of ${plural(answers, "answer")}` }),
  ];
}
