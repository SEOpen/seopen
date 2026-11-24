/** The tops of the keyword research pages, from data already on the page. Pure, so it's tested and costs nothing. */
import type { FigureData } from "@/components/ui/figure";
import { briefSentence, changeDelta, countDelta, countMove, countOf, MIN_WEIGHT } from "@/lib/brief";
import { formatDate, formatDay, formatNumber, formatPct, formatShortDate, formatUsd } from "@/lib/format";
import { kdLabel } from "./format";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "the United States", "Germany". */
export const countryName = (name: string) => (/^(United |Netherlands)/.test(name) ? `the ${name}` : name);

const searches = (n: number) => `${formatNumber(n)} ${n === 1 ? "search" : "searches"}`;

/** Below this difficulty a keyword reads "Very easy" or "Easy". */
const EASY = 30;

const WEEK_MS = 7 * 86_400_000;

// ─── One keyword: /keywords ──────────────────────────────────────────────────────────────────

export interface LookupBrief {
  keyword: string;
  /** The country the metrics are for, already with its article. */
  place: string;
  volume: number | null;
  /** Percent change on a year ago, for the latest month where `latest` is given. Null when there's no earlier number. */
  yearly: number | null;
  /**
   * The latest month with a number. `volume` is Google's 12-month average and `yearly` compares single
   * months, so a keyword can average 720 and be down 93%: 170 in its latest month. Left out with no monthly rows.
   */
  latest?: { month: string; volume: number } | null;
  kd: number | null;
  cpc: number | null;
  competition: number | null;
  competitionLevel: string | null;
  /** The city being researched. `reportable` is false when Google Ads can't take the phrase. */
  city?: { name: string; volume: number | null; reportable: boolean } | null;
  /** The project's place in the top 10. Left out with no project, or before the top 10 is loaded. */
  own?: { domain: string; position: number | null } | null;
}

/** The volume a year ago, worked back from the change. Whole below 20, where it's shown as a plain difference. */
function yearAgo(volume: number, yearly: number): number | null {
  if (yearly <= -100) return null;
  const before = volume / (1 + yearly / 100);
  return before < 20 ? Math.round(before) : before;
}

/** "2026-09" → "Sep 2026". */
const monthLabel = (month: string) => formatDay(`${month}-01`).replace(/ \d+,/, "");

/** The latest month against the same month a year earlier. */
function latestMonthClause(latest: NonNullable<LookupBrief["latest"]>, yearly: number | null, across: string): string {
  const had = `${monthLabel(latest.month)} had ${formatNumber(latest.volume)}${across}`;
  const before = yearly == null ? null : yearAgo(latest.volume, yearly);
  if (before == null) return `${had}.`;
  if (Math.max(latest.volume, before) < 20) {
    const change = Math.round(latest.volume - before);
    return `${had}, ${change === 0 ? "the same as" : `${change > 0 ? "up" : "down"} ${Math.abs(change)} on`} a year earlier.`;
  }
  const move = countMove("searches", latest.volume, before, "on a year earlier");
  return `${had}, ${move && move.weight >= MIN_WEIGHT ? move.clause.replace("searches are ", "") : "about the same as a year earlier"}.`;
}

/** How much this keyword is searched, and how that has moved in a year. */
export function lookupSentence(b: Pick<LookupBrief, "keyword" | "place" | "volume" | "yearly" | "city" | "latest">): string {
  const { keyword, place, volume, yearly, city, latest } = b;
  if (!volume) return `“${keyword}” has no search volume on record in ${place}.`;
  if (latest) {
    const average =
      city?.volume != null
        ? `“${keyword}” gets about ${searches(city.volume)} a month in ${city.name} and ${formatNumber(volume)} across ${place}, averaged over 12 months.`
        : `“${keyword}” gets about ${searches(volume)} a month in ${place}, averaged over 12 months.`;
    return `${average} ${latestMonthClause(latest, yearly, city?.volume != null ? ` across ${place}` : "")}`;
  }
  const lead =
    city?.volume != null
      ? `“${keyword}” gets about ${searches(city.volume)} a month in ${city.name} and ${formatNumber(volume)} across ${place}.`
      : `“${keyword}” gets about ${searches(volume)} a month in ${place}.`;
  const before = yearly == null ? null : yearAgo(volume, yearly);
  if (before == null) return `${lead} There's no year-ago number to compare with.`;
  if (Math.max(volume, before) < 20) {
    const change = Math.round(volume - before);
    return `${lead} That's ${change === 0 ? "the same as" : `${change > 0 ? "up" : "down"} ${Math.abs(change)} on`} a year ago.`;
  }
  const noun = city?.volume != null ? `searches across ${place}` : "searches";
  const move = countMove(noun, volume, before, "on a year ago");
  return `${lead} ${briefSentence(move ? [move] : [], "That's about the same as a year ago.")}`;
}

function cityClause(city: LookupBrief["city"]): string | null {
  if (!city) return null;
  if (!city.reportable) return `Google Ads can't report on this phrase for ${city.name}`;
  return city.volume == null ? `too few in ${city.name} for Google to report a number` : `${formatNumber(city.volume)} in ${city.name}`;
}

/** Volume, difficulty and cost per click, then where the project sits in the top 10 when there's a project. */
export function lookupFigures(b: LookupBrief): FigureData[] {
  const clause = cityClause(b.city);
  const before = b.yearly == null ? null : b.latest ? yearAgo(b.latest.volume, b.yearly) : b.volume != null ? yearAgo(b.volume, b.yearly) : null;
  const latestCaption = b.latest && `${monthLabel(b.latest.month)}${before != null ? ` (${formatNumber(b.latest.volume)}) vs a year earlier` : ` had ${formatNumber(b.latest.volume)}`}`;
  const figures: FigureData[] = [
    b.volume == null
      ? { id: "volume", label: "Search volume", state: "empty", text: `No search volume on record in ${b.place}${clause ? `, ${clause}` : ""}.` }
      : {
          id: "volume",
          label: "Search volume",
          state: "value",
          value: formatNumber(b.volume),
          delta: countDelta(b.latest ? b.latest.volume : b.volume, before),
          caption: b.latest
            ? `${[`a month in ${b.place}, averaged over 12 months`, clause].filter(Boolean).join(", ")}. ${before != null ? "The change is " : ""}${latestCaption}`
            : [`a month in ${b.place}`, before != null ? "vs a year ago" : null, clause].filter(Boolean).join(", "),
        },
    b.kd == null
      ? { id: "kd", label: "Keyword difficulty", state: "empty", text: "No difficulty score for this keyword." }
      : { id: "kd", label: "Keyword difficulty", state: "value", value: String(Math.round(b.kd)), delta: null, caption: `${kdLabel(b.kd)}. 0 to 100, lower is easier` },
    b.cpc == null
      ? { id: "cpc", label: "Cost per click", state: "empty", text: "No ad data for this keyword." }
      : {
          id: "cpc",
          label: "Cost per click",
          state: "value",
          value: formatUsd(b.cpc),
          delta: null,
          caption: b.competitionLevel ? `On Google Ads, ${b.competitionLevel.toLowerCase()} competition${b.competition != null ? ` (${formatPct(b.competition, 0)})` : ""}` : "On Google Ads",
        },
  ];
  if (b.own) {
    figures.push(
      b.own.position == null
        ? { id: "own", label: "Top 10 position", state: "empty", text: `${b.own.domain} isn't in the top 10.` }
        : { id: "own", label: "Top 10 position", state: "value", value: `#${b.own.position}`, delta: null, caption: `${b.own.domain}, in the top 10 below` },
    );
  }
  return figures;
}

// ─── An idea list: /keywords/ideas ───────────────────────────────────────────────────────────

export type IdeaKind = "suggestions" | "related" | "questions";

const IDEA_NOUN: Record<IdeaKind, [string, string]> = {
  suggestions: ["suggestion", "suggestions"],
  related: ["related search", "related searches"],
  questions: ["question", "questions"],
};

interface IdeaRow {
  keyword: string;
  volume: number | null;
  kd: number | null;
}

const easyCount = (rows: IdeaRow[]) => rows.filter((r) => r.kd != null && r.kd < EASY).length;

/** How many ideas came back, and how many of them look winnable. */
export function ideasSentence({ seed, kind, rows }: { seed: string; kind: IdeaKind; rows: IdeaRow[] }): string {
  const [one, many] = IDEA_NOUN[kind];
  const found = `${capitalize(countOf(rows.length, one, many))} for “${seed}”`;
  if (!rows.some((r) => r.kd != null)) return `${found}.`;
  const easy = easyCount(rows);
  if (rows.length === 1) return `${found}, and it's ${easy ? "" : "not "}easy to rank for.`;
  if (!easy) return `${found}, none of them easy to rank for.`;
  if (easy === rows.length) return `${found}, all of them easy to rank for.`;
  return `${found}, ${countOf(easy, "of them", "of them")} easy to rank for.`;
}

export function ideasFigures({ rows, total }: { rows: IdeaRow[]; total: number }): FigureData[] {
  const withVolume = rows.filter((r) => r.volume != null);
  const top = withVolume.reduce<IdeaRow | null>((best, r) => (!best || r.volume! > best.volume! ? r : best), null);
  const scored = rows.some((r) => r.kd != null);
  return [
    { id: "ideas", label: "Ideas", state: "value", value: formatNumber(rows.length), delta: null, caption: total > rows.length ? `the top ${formatNumber(rows.length)} of ${formatNumber(total)} by volume` : "everything found" },
    top
      ? { id: "volume", label: "Searches a month", state: "value", value: formatNumber(withVolume.reduce((n, r) => n + r.volume!, 0)), delta: null, caption: "added up across these ideas" }
      : { id: "volume", label: "Searches a month", state: "empty", text: "No search volumes for these ideas." },
    scored
      ? { id: "easy", label: "Easy to rank for", state: "value", value: formatNumber(easyCount(rows)), delta: null, caption: `difficulty under ${EASY}` }
      : { id: "easy", label: "Easy to rank for", state: "empty", text: "No difficulty scores for these ideas." },
    top
      ? { id: "top", label: "Most searched", state: "value", value: formatNumber(top.volume), delta: null, caption: top.keyword }
      : { id: "top", label: "Most searched", state: "empty", text: "No search volumes for these ideas." },
  ];
}

// ─── Saved lists: /keywords/lists ────────────────────────────────────────────────────────────

interface ListRow {
  name: string;
  keywords: number;
  volume: number;
  updatedAt: string;
}

const withinWeek = (d: Date | string, now: Date) => now.getTime() - new Date(d).getTime() < WEEK_MS;

/** What changed in the last week, and what the lists hold. */
export function listsSentence(lists: ListRow[], now: Date): string {
  if (!lists.length) return "No saved lists yet.";
  const keywords = lists.reduce((n, l) => n + l.keywords, 0);
  const held = `${capitalize(countOf(keywords, "keyword"))} saved across ${countOf(lists.length, "list")}.`;
  const changed = lists.filter((l) => withinWeek(l.updatedAt, now)).length;
  return changed ? `${capitalize(countOf(changed, "list"))} changed in the last 7 days. ${held}` : `Nothing changed in the last 7 days. ${held}`;
}

export function listsFigures(lists: ListRow[], timeZone: string): FigureData[] {
  const latest = lists.reduce<ListRow | null>((best, l) => (!best || new Date(l.updatedAt) > new Date(best.updatedAt) ? l : best), null);
  return [
    { id: "lists", label: "Lists", state: "value", value: formatNumber(lists.length), delta: null, caption: "in this project" },
    { id: "keywords", label: "Saved keywords", state: "value", value: formatNumber(lists.reduce((n, l) => n + l.keywords, 0)), delta: null, caption: "across all lists" },
    { id: "volume", label: "Searches a month", state: "value", value: formatNumber(lists.reduce((n, l) => n + l.volume, 0)), delta: null, caption: "added up, as of when each was saved" },
    { id: "updated", label: "Last updated", state: "value", value: latest ? formatShortDate(latest.updatedAt, timeZone) : "–", delta: null, caption: latest?.name },
  ];
}

// ─── One list: /keywords/lists/[id] ──────────────────────────────────────────────────────────

interface ListItem {
  keyword: string;
  volume: number | null;
  kd: number | null;
  createdAt: Date | string;
}

const QUESTION = /^(how|what|why|when|where|who|which|can|does|is|are|should)\b/;

/** What was added in the last week. Removals aren't recorded, so it says nothing about those. */
export function listSentence(items: ListItem[], now: Date): string {
  if (!items.length) return "This list is empty.";
  const added = items.filter((i) => withinWeek(i.createdAt, now)).length;
  if (!added) return `Nothing added in the last 7 days. The list holds ${countOf(items.length, "keyword")}.`;
  if (added === items.length) return `${capitalize(countOf(added, "keyword"))} added in the last 7 days, the whole list so far.`;
  return `${capitalize(countOf(added, "keyword"))} added in the last 7 days. The list holds ${countOf(items.length, "keyword")}.`;
}

export function listFigures(items: ListItem[], now: Date, timeZone: string): FigureData[] {
  const added = items.filter((i) => withinWeek(i.createdAt, now));
  const kds = items.filter((i) => i.kd != null);
  const avgKd = kds.length ? Math.round(kds.reduce((n, i) => n + i.kd!, 0) / kds.length) : null;
  const newest = items.reduce<Date | string | null>((latest, i) => (!latest || new Date(i.createdAt) > new Date(latest) ? i.createdAt : latest), null);
  return [
    {
      id: "keywords",
      label: "Keywords",
      state: "value",
      value: formatNumber(items.length),
      delta: added.length ? changeDelta(added.length, "number", "up") : null,
      caption: added.length ? "added in the last 7 days" : newest ? `last added ${formatDate(newest, timeZone)}` : undefined,
    },
    { id: "volume", label: "Searches a month", state: "value", value: formatNumber(items.reduce((n, i) => n + (i.volume ?? 0), 0)), delta: null, caption: "added up, as of when each was saved" },
    avgKd == null
      ? { id: "kd", label: "Average difficulty", state: "empty", text: "No difficulty scores saved in this list." }
      : { id: "kd", label: "Average difficulty", state: "value", value: String(avgKd), delta: null, caption: `${kdLabel(avgKd)}. 0 to 100, lower is easier` },
    { id: "questions", label: "Questions", state: "value", value: formatNumber(items.filter((i) => QUESTION.test(i.keyword)).length), delta: null, caption: "start with a word like how or what" },
  ];
}
