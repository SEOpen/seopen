/**
 * The top of the Analytics page. GA4, PostHog, Plausible and Umami fill the same table, so one brief serves them all. Pure, so
 * it's tested and costs nothing to load.
 */
import type { ColumnSpec } from "@/components/ui/data-table";
import type { FigureData } from "@/components/ui/figure";
import { chartDay } from "@/components/ui/module-card";
import { briefSentence, changeDelta, countDelta, countMove, countOf, type Move } from "@/lib/brief";
import { formatNumber, formatPct, formatUsd } from "@/lib/format";
import { daysBetween, pctChange, type Compare, type Periods } from "@/modules/google/windowing";

export interface AnalyticsTotals {
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  totalRevenue: number;
}

export interface AnalyticsBrief {
  source: "ga4" | "posthog" | "plausible" | "umami";
  periods: Periods;
  compare: Compare;
  /** The first day of stored history. */
  first: string;
  current: AnalyticsTotals;
  /** The earlier period's totals, or null when there isn't one. */
  previous: AnalyticsTotals | null;
  /** How many landing pages had organic sessions in the period. */
  pages: number;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const usd = (n: number) => formatUsd(n, 0);
const periodDays = (p: Periods) => daysBetween(p.current.start, p.current.end) + 1;

/** Whether the earlier period is stored in full. Part of one would read as a jump that didn't happen. */
export const comparesFairly = (periods: Periods, first: string) => !!periods.previous && periods.previous.start >= first;

/** The earlier period in words: "the 28 days before", "the same days last year". */
export const earlierPeriod = (compare: Compare, periods: Periods) => (compare === "yoy" ? "the same days last year" : `the ${periodDays(periods)} days before`);

/** The earlier period's name in a chart's legend. */
export const earlierLabel = (compare: Compare, periods: Periods) => (compare === "yoy" ? "Same days last year" : `Previous ${periodDays(periods)} days`);

/** Up or down as a clause, or from → to where a percentage would overstate a small number or start from zero. */
function move(noun: string, now: number, before: number, { format = formatNumber, verb = "are", money = false }: { format?: (n: number) => string; verb?: "is" | "are"; money?: boolean } = {}): Move | null {
  const big = countMove(noun, now, before, "", "up", money);
  if (big) return { ...big, clause: big.clause.trimEnd().replace(" are ", ` ${verb} `) };
  if (now === before) return null;
  return { clause: `${noun} went from ${format(before)} to ${format(now)}`, tone: now > before ? "good" : "bad", weight: Math.abs(now - before) / Math.max(before, 1) };
}

/** What changed against the earlier period, or plainly what's there when nothing can be compared yet. */
export function analyticsSentence(b: AnalyticsBrief): string {
  const { current: cur, previous: prev, periods } = b;
  const startedInside = b.first > periods.current.start;
  const span = startedInside ? `since ${chartDay(b.first)}` : `in the ${periodDays(periods)} days to ${chartDay(periods.current.end)}`;
  const total = cur.sessions ? countOf(cur.sessions, "organic session") : "no organic sessions";
  const plain = `${capitalize(total)} ${span}.`;

  if (b.compare === "none") return plain;
  if (!prev || !periods.previous) return `${plain} Changes show once there's an earlier period to compare.`;
  if (!comparesFairly(periods, b.first)) return `${plain} The earlier period is only partly stored, so there's no fair comparison yet.`;

  const against = earlierPeriod(b.compare, periods);
  const moves = [
    move("organic sessions", cur.sessions, prev.sessions),
    b.source === "ga4" ? move("key events", cur.keyEvents, prev.keyEvents) : null,
    b.source === "ga4" ? move("revenue", cur.totalRevenue, prev.totalRevenue, { format: usd, verb: "is", money: true }) : null,
  ].filter((m): m is Move => !!m);
  const moved = briefSentence(moves, "");
  if (moved) return `${moved.slice(0, -1)}, compared with ${against}.`;

  if (!cur.sessions && !prev.sessions) return `No organic sessions ${span}, and none in ${against}.`;
  if (cur.sessions === prev.sessions) return `Nothing moved: ${total} ${span}, the same as ${against}.`;
  return `Little changed: ${total} ${span}, against ${formatNumber(prev.sessions)} in ${against}.`;
}

/** The numbers the page leads on. PostHog, Plausible and Umami have no key events or revenue to match GA4's, so they count landing pages instead. */
export function analyticsFigures(b: AnalyticsBrief): FigureData[] {
  const { current: cur, periods } = b;
  const prev = comparesFairly(periods, b.first) ? b.previous : null;
  const startedInside = b.first > periods.current.start;
  const covers = startedInside ? `since ${chartDay(b.first)}` : `${periodDays(periods)} days to ${chartDay(periods.current.end)}`;
  const versus =
    b.compare === "none" ? null
    : prev ? `vs ${b.compare === "yoy" ? "the same days last year" : `the ${periodDays(periods)} before`}`
    : b.previous ? "earlier period only partly stored"
    : "nothing earlier to compare";
  const describe = (what: string) => (versus ? `${what}, ${versus}` : what);
  // Revenue stays a percentage at any size, as on the Overview card: a plain difference would have to say which currency.
  const revenue = pctChange(cur.totalRevenue, prev?.totalRevenue);

  const sessions: FigureData = { state: "value", id: "sessions", label: "Organic sessions", value: formatNumber(cur.sessions), delta: countDelta(cur.sessions, prev?.sessions), caption: describe(covers) };
  const engaged: FigureData = {
    state: "value",
    id: "engaged",
    label: "Engaged sessions",
    value: formatNumber(cur.engagedSessions),
    delta: countDelta(cur.engagedSessions, prev?.engagedSessions),
    caption: describe(cur.sessions ? `${formatPct(cur.engagedSessions / cur.sessions)} ${b.source === "ga4" ? "of sessions" : "not bounced"}` : covers),
  };
  if (b.source !== "ga4") {
    return [sessions, engaged, { state: "value", id: "pages", label: "Landing pages", value: formatNumber(b.pages), delta: null, caption: `with organic sessions, ${covers}` }];
  }
  return [
    sessions,
    engaged,
    { state: "value", id: "key-events", label: "Key events", value: formatNumber(cur.keyEvents), delta: countDelta(cur.keyEvents, prev?.keyEvents), caption: describe("from organic search") },
    // Most sites record no revenue, and "$0" would read as if they'd lost it.
    cur.totalRevenue > 0 || (prev?.totalRevenue ?? 0) > 0
      ? { state: "value", id: "revenue", label: "Revenue", value: usd(cur.totalRevenue), delta: revenue == null ? null : changeDelta(revenue, "percent", "up"), caption: describe("from organic search") }
      : { state: "empty", id: "revenue", label: "Revenue", text: "None recorded in GA4 for this period." },
  ];
}

type PageRow = Partial<Record<"keyEvents" | "totalRevenue" | "gscClicks" | "gscImpressions" | "gscCtr" | "gscPosition", number | null>>;

/**
 * The landing pages table. A column empty in every row hides: Search Console's when it has no row for any
 * page (a 0 is still a reading there), key events and revenue when no page recorded any.
 */
export function landingPageColumns(rows: readonly PageRow[], { source, compare }: { source: AnalyticsBrief["source"]; compare: boolean }): ColumnSpec[] {
  const unmatched = (key: keyof PageRow) => rows.every((r) => r[key] == null);
  const none = (key: keyof PageRow) => rows.every((r) => !r[key]);
  const specs: (ColumnSpec | false)[] = [
    { key: "landingPage", label: "Landing page", format: "link", href: "/gsc/page?url={gscPage}" },
    { key: "sessions", label: "Sessions", format: "number" },
    compare && { key: "sessionsDelta", label: "Change", format: "delta" },
    { key: "engagementRate", label: "Engaged", format: "pct" },
    source === "ga4" && !none("keyEvents") && { key: "keyEvents", label: "Key events", format: "number" },
    source === "ga4" && !none("totalRevenue") && { key: "totalRevenue", label: "Revenue", format: "usd" },
    !unmatched("gscClicks") && { key: "gscClicks", label: "Search clicks", format: "number" },
    !unmatched("gscImpressions") && { key: "gscImpressions", label: "Impressions", format: "number" },
    !unmatched("gscCtr") && { key: "gscCtr", label: "Click rate", format: "pct" },
    !unmatched("gscPosition") && { key: "gscPosition", label: "Search Console position", format: "position" },
  ];
  return specs.filter((c): c is ColumnSpec => !!c);
}
