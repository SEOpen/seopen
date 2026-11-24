/** The top of each Domain analysis page, from the data the page has already loaded. Pure, so it's tested and costs nothing. */
import type { FigureData } from "@/components/ui/figure";
import { briefSentence, countDelta, countMove, countOf, countWord, MIN_WEIGHT, type Move } from "@/lib/brief";
import { formatDay, formatNumber, formatPct, formatUsd } from "@/lib/format";
import { GAP_TABS, kpis, type CompetitorRow, type GapTab, type HistoryPoint, type PageRow, type RankView } from "./transform";
import type { OrganicMetrics } from "./types";

/** "2026-09" → "Sep 2026". */
export const monthLabel = (month: string) => formatDay(`${month}-01`).replace(/ \d+,/, "");

/** Under the new and lost counts: they run from the index's last update, and the figures at the top compare months. */
export const CHANGES_NOTE = "Counted from our index's last update. The changes at the top of the page compare months, so the two won't add up.";

const value = (f: { id: string; label: string; value: string; caption?: string; href?: string; delta?: ReturnType<typeof countDelta> }): FigureData => ({ state: "value", ...f, delta: f.delta ?? null });

/** Keywords that moved since the provider's last update, or null when none did. */
function sinceLastUpdate(up: number, down: number, opening = "Since the last update"): string | null {
  const rose = `${countOf(up, "keyword")} ${up === 1 ? "is" : "are"} new or moved up`;
  if (up && down) return `${opening}, ${rose}, and ${countWord(down)} moved down or dropped out.`;
  if (up) return `${opening}, ${rose}.`;
  if (down) return `${opening}, ${countOf(down, "keyword")} moved down or dropped out.`;
  return null;
}

/**
 * The month to compare the overview with: the newest in the history before the month it was read in.
 * The history can end on that month or, early in a month, on the one before. So it isn't always the
 * second-to-last point, which would skip a finished month.
 */
export function monthBefore(history: HistoryPoint[] | null, readAt: Date): HistoryPoint | undefined {
  const reading = readAt.toISOString().slice(0, 7);
  return history?.findLast((p) => p.date < reading);
}

/**
 * Traffic or keywords moving against the month before lead, since they're the point of the page. Under
 * that, what moved at the last update. `readAt` is when the overview was fetched. Null history: it isn't
 * loaded, so nothing can be said about earlier months either way.
 */
export function domainSentence(domain: string, organic: OrganicMetrics, history: HistoryPoint[] | null, readAt: Date): string {
  const k = kpis(organic)!;
  const earlier = monthBefore(history, readAt);
  if (earlier) {
    const moves = [countMove("estimated clicks", k.traffic, earlier.traffic, ""), countMove("ranking keywords", k.keywords, earlier.keywords, "")].filter((m): m is Move => !!m && m.weight >= MIN_WEIGHT);
    if (moves.length) return briefSentence(moves.map((m) => ({ ...m, clause: m.clause.trim() })), "").replace(/\.$/, `, compared with ${monthLabel(earlier.date)}.`);
  }
  const changed = sinceLastUpdate(organic.is_new + organic.is_up, organic.is_down + organic.is_lost);
  if (changed) return changed;
  return earlier || !history ? "Nothing moved since the last update." : `First look at ${domain}. Changes show after the next update.`;
}

export function domainFigures(organic: OrganicMetrics, history: HistoryPoint[] | null, readAt: Date): FigureData[] {
  const k = kpis(organic)!;
  const earlier = monthBefore(history, readAt);
  // These are monthly totals. Keywords can still have moved at the last update, which the sentence reports.
  const since = earlier ? `, vs ${monthLabel(earlier.date)}` : history ? ", no earlier monthly total" : "";
  return [
    value({ id: "traffic", label: "Est. monthly traffic", value: formatNumber(k.traffic), delta: earlier && countDelta(k.traffic, earlier.traffic), caption: `clicks from Google${since}` }),
    value({ id: "keywords", label: "Organic keywords", value: formatNumber(k.keywords), delta: earlier && countDelta(k.keywords, earlier.keywords), caption: `${formatNumber(k.top3)} in the top 3${since}` }),
    value({ id: "top10", label: "Top 10 keywords", value: formatNumber(k.top10), delta: earlier && countDelta(k.top10, earlier.top10), caption: `${k.keywords ? `${formatPct(k.top10 / k.keywords, 0)} of all` : "in the top 10"}${since}` }),
    value({ id: "value", label: "Traffic value", value: formatUsd(Math.round(k.trafficValue), 0), caption: "what the clicks would cost as ads" }),
  ];
}

export type ViewCounts = Record<RankView, number>;

/** What the loaded rows say moved. `onePage` when they're filtered to a single URL. */
export function keywordsSentence(domain: string, counts: ViewCounts, onePage = false): string {
  if (!counts.all && !counts.lost) return onePage ? "None of the keywords loaded rank on this page." : `None of the keywords loaded rank for ${domain} yet.`;
  const changed = sinceLastUpdate(counts.new + counts.improved, counts.declined + counts.lost, onePage ? "On this page, since the last update" : undefined);
  return changed ?? (onePage ? "Nothing moved on this page since the last update." : "Nothing moved since the last update.");
}

export function keywordsFigures({ counts, traffic, loaded, total, links }: { counts: ViewCounts; traffic: number; loaded: number; total: number; links: { up: string; down: string } }): FigureData[] {
  return [
    value({ id: "ranking", label: "Ranking keywords", value: formatNumber(counts.all), caption: `from ${formatNumber(loaded)} of ${formatNumber(total)} rows, the highest traffic first` }),
    value({ id: "traffic", label: "Est. monthly traffic", value: formatNumber(Math.round(traffic)), caption: "clicks from these keywords" }),
    value({ id: "up", label: "Moved up", href: links.up, value: formatNumber(counts.new + counts.improved), caption: `${formatNumber(counts.new)} new, ${formatNumber(counts.improved)} improved` }),
    value({ id: "down", label: "Moved down", href: links.down, value: formatNumber(counts.declined + counts.lost), caption: `${formatNumber(counts.declined)} declined, ${formatNumber(counts.lost)} lost` }),
  ];
}

const byTraffic = <T extends { traffic: number }>(rows: T[]) => [...rows].sort((a, b) => b.traffic - a.traffic);

/** A snapshot with no earlier one, so it says where the traffic sits rather than what moved. */
export function pagesSentence(domain: string, rows: Pick<PageRow, "traffic" | "share">[]): string {
  if (!rows.length) return `No pages with organic traffic found for ${domain}.`;
  const sorted = byTraffic(rows);
  if (!sorted[0].traffic) return `None of the ${countOf(rows.length, "page")} loaded has any estimated traffic yet.`;
  if (rows.length === 1) return "One page brings all the estimated traffic.";
  const top = rows.length > 3 ? 3 : 1;
  const share = sorted.slice(0, top).reduce((n, r) => n + r.share, 0);
  return `The top ${top === 3 ? "three pages bring" : "page brings"} ${formatPct(share, 0)} of the estimated traffic across the ${countOf(rows.length, "page")} loaded.`;
}

export function pagesFigures(rows: Pick<PageRow, "path" | "traffic" | "share" | "trafficValue">[], total: number): FigureData[] {
  if (!rows.length) return [];
  const [top] = byTraffic(rows);
  // A page with traffic and no price has no CPC data for its keywords, so it adds nothing and the caption says so.
  const unpriced = rows.filter((r) => r.trafficValue == null).length;
  const valueCaption = unpriced
    ? `what the clicks would cost as ads. ${countOf(unpriced, "page").replace(/^./, (c) => c.toUpperCase())} ${unpriced === 1 ? "has" : "have"} no CPC data`
    : "what the clicks would cost as ads";
  return [
    value({ id: "pages", label: "Pages", value: formatNumber(rows.length), caption: `of ${formatNumber(total)}, the highest traffic first` }),
    value({ id: "traffic", label: "Est. monthly traffic", value: formatNumber(rows.reduce((n, r) => n + r.traffic, 0)), caption: "clicks to these pages" }),
    value({ id: "top", label: "Top page", value: formatPct(top.share, 0), caption: `of the traffic: ${top.path}` }),
    value({ id: "value", label: "Traffic value", value: formatUsd(Math.round(rows.reduce((n, r) => n + (r.trafficValue ?? 0), 0)), 0), caption: valueCaption }),
  ];
}

const mostBy = (rows: CompetitorRow[], key: "common" | "overlap" | "traffic") => rows.reduce((best, r) => (r[key] > best[key] ? r : best));

export function competitorsSentence(target: string, rows: CompetitorRow[]): string {
  if (!rows.length) return `No organic competitors found for ${target} in this market.`;
  const top = mostBy(rows, "common");
  return `${top.domain} shares the most keywords with ${target}: ${countOf(top.common, "keyword")}${top.overlap ? `, ${formatPct(top.overlap, 0)} of ${target}'s` : ""}.`;
}

export function competitorsFigures(rows: CompetitorRow[], total: number, overviewHref: string): FigureData[] {
  if (!rows.length) return [];
  const shared = mostBy(rows, "common");
  const overlap = mostBy(rows, "overlap");
  const biggest = mostBy(rows, "traffic");
  return [
    value({ id: "found", label: "Competitors", value: formatNumber(rows.length), caption: `of ${formatNumber(total)}, the most keywords in common first` }),
    value({ id: "common", label: "Most in common", value: formatNumber(shared.common), caption: `keywords, ${shared.domain}` }),
    overlap.overlap
      ? value({ id: "overlap", label: "Highest overlap", value: formatPct(overlap.overlap, 0), caption: `of the keywords, ${overlap.domain}` })
      : { id: "overlap", label: "Highest overlap", state: "empty", text: "Overlap needs this domain's overview.", action: { label: "Open Overview", href: overviewHref } },
    value({ id: "traffic", label: "Most traffic", value: formatNumber(biggest.traffic), caption: `clicks a month, ${biggest.domain}` }),
  ];
}

/** What the comparison says now: there's no earlier comparison to set it against. */
export function gapSentence(domains: string[], counts: Record<GapTab, number>): string {
  const [you, ...others] = domains;
  const them = others.length === 1 ? others[0] : "all the others";
  const rank = others.length === 1 ? "ranks" : "rank";
  // Missing means all the others rank. With two or more, a keyword only some of them have is Untapped, so missing none doesn't mean nothing to win.
  const untapped = others.length > 1 ? counts.untapped : 0;
  const elsewhere = `at least one of them ranks for ${countOf(untapped, "keyword")} ${you} doesn't`;
  if (!counts.all) return "None of these domains have keywords loaded to compare.";
  if (counts.missing && counts.strong) return `${you} doesn't rank for ${countOf(counts.missing, "keyword")} that ${them} ${rank} for, and ranks above ${others.length === 1 ? them : "them"} on ${countWord(counts.strong)}.`;
  if (counts.missing) return `${you} doesn't rank for ${countOf(counts.missing, "keyword")} that ${them} ${rank} for.`;
  if (counts.strong) return `${you} ranks above ${them} on ${countOf(counts.strong, "keyword")} and isn't missing any${others.length === 1 ? "" : " they all rank for"}${untapped ? `, but ${elsewhere}` : ""}.`;
  if (untapped) return `${you} isn't missing any keywords ${them} ${rank} for and doesn't lead on any, but ${elsewhere}.`;
  return `Nothing stands out: ${you} isn't missing any keywords ${them} ${rank} for, and doesn't lead on any.`;
}

export function gapFigures(counts: Record<GapTab, number>, link: (tab: GapTab) => string): FigureData[] {
  return (["missing", "weak", "strong", "unique"] as const).map((tab) => value({ id: tab, label: GAP_TABS[tab].label, href: link(tab), value: formatNumber(counts[tab]), caption: GAP_TABS[tab].help }));
}
