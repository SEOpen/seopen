/**
 * Pure date math for the Google syncs. Dates are "YYYY-MM-DD" strings; arithmetic runs in UTC
 * so a date never shifts with the server's time zone. GSC dates are Pacific Time, GA4 dates are
 * in the property's time zone; both arrive as plain dates and are stored as-is.
 */

export interface DateRange {
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;

function toUtc(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  return fromUtc(toUtc(d) + n * DAY_MS);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * How many of a window's days are stored, for a dashboard's "N days to ...". `series` starts where stored
 * history does, so a new property has fewer than the window. With a whole earlier period stored, it's full.
 */
export function storedDays(d: { end: string; previous: unknown; series: readonly { date: string }[] }, window: number): number {
  const first = d.series[0]?.date;
  return d.previous || !first ? window : Math.min(window, daysBetween(first, d.end) + 1);
}

/** Inclusive list of dates from start to end. */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Today's date in a time zone, e.g. "America/Los_Angeles" for Search Console. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const GSC_TIME_ZONE = "America/Los_Angeles";

/** First date Search Console still serves: 16 months back, plus a 2-day margin for its rolling edge. */
export function historyStart(today: string, months = 16): string {
  const [y, m, d] = today.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1 - months, d));
  return addDays(fromUtc(back.getTime()), 2);
}

export interface WindowState {
  /** Oldest date the backfill aims for. */
  backfillStart: string;
  /** Next date to backfill, moving forward. Null before the first run. */
  backfillCursor: string | null;
  backfillDone: boolean;
  /** Newest date already stored. */
  latestStored: string | null;
}

export interface SyncPlan {
  /** The trailing window that is always re-pulled (late data, revisions). */
  recent: DateRange | null;
  /** The next slice of history to fill, oldest first. */
  backfill: DateRange | null;
  /** State to save after both ranges succeed. */
  next: Pick<WindowState, "backfillCursor" | "backfillDone">;
}

/**
 * Decides what one sync run fetches.
 *
 * - `recent`: the last `recentDays` days up to `newest` (the newest date with final data).
 * - `backfill`: up to `budgetDays` days from the cursor, oldest first, stopping before `recent`.
 *   The first run starts at `earliestWithData` (or the window start). A gap left by a paused
 *   worker re-opens the backfill from the day after the newest stored date.
 * - The backfill window slides: a cursor older than `backfillStart` jumps forward.
 */
export function planSync(input: {
  newest: string | null;
  recentDays: number;
  budgetDays: number;
  state: WindowState;
  earliestWithData?: string | null;
}): SyncPlan {
  const { newest, recentDays, budgetDays, state } = input;
  if (!newest || newest < state.backfillStart) {
    return { recent: null, backfill: null, next: { backfillCursor: state.backfillCursor, backfillDone: state.backfillDone } };
  }

  const firstRecent = maxDate(addDays(newest, -(recentDays - 1)), state.backfillStart);
  const recent = { start: firstRecent, end: newest };
  const lastBackfillDay = addDays(firstRecent, -1);

  let cursor: string | null;
  if (!state.backfillDone) {
    cursor = state.backfillCursor ?? input.earliestWithData ?? state.backfillStart;
  } else if (state.latestStored && state.latestStored < lastBackfillDay) {
    cursor = addDays(state.latestStored, 1);
  } else {
    cursor = null;
  }
  if (cursor && cursor < state.backfillStart) cursor = state.backfillStart;

  if (!cursor || cursor > lastBackfillDay) {
    return { recent, backfill: null, next: { backfillCursor: null, backfillDone: true } };
  }

  const end = minDate(addDays(cursor, budgetDays - 1), lastBackfillDay);
  const nextCursor = addDays(end, 1);
  const done = nextCursor > lastBackfillDay;
  return {
    recent,
    backfill: { start: cursor, end },
    next: { backfillCursor: done ? null : nextCursor, backfillDone: done },
  };
}

/** Newest final date from a dataState "all" probe: the day before first_incomplete_date, else the newest row. */
export function newestFinalDate(datesWithData: string[], firstIncompleteDate?: string | null): string | null {
  const final = firstIncompleteDate ? datesWithData.filter((d) => d < firstIncompleteDate) : datesWithData;
  return final.length ? final.reduce(maxDate) : null;
}

/** Splits a range into chunks of at most `days` days, oldest first. */
export function chunkRange(range: DateRange, days: number): DateRange[] {
  const out: DateRange[] = [];
  for (let s = range.start; s <= range.end; s = addDays(s, days)) {
    out.push({ start: s, end: minDate(addDays(s, days - 1), range.end) });
  }
  return out;
}

export type Compare = "prev" | "yoy" | "none";

export interface Periods {
  current: DateRange;
  previous: DateRange | null;
}

/** The selected period ends at the newest stored date; the compare period has the same length. */
export function resolvePeriods(latest: string, days: number, compare: Compare): Periods {
  const current = { start: addDays(latest, -(days - 1)), end: latest };
  if (compare === "none") return { current, previous: null };
  if (compare === "yoy") return { current, previous: { start: addDays(current.start, -364), end: addDays(current.end, -364) } };
  return { current, previous: { start: addDays(current.start, -days), end: addDays(current.start, -1) } };
}

/** Percentage change, or null when there is no baseline. */
export function pctChange(cur: number, prev: number | null | undefined): number | null {
  if (prev == null || prev === 0) return null;
  return (cur - prev) / prev;
}

/**
 * A period's daily rows lined up with the period before by day offset, one row for every day in the
 * range, so a quiet day or a gap in either period can't shift or drop the other. `zero` names the keys
 * that count something: a day with no row is a 0 for those and a gap for the rest (a position has no
 * value on a day with no impressions). `first` is the start of stored history: there's no saying what
 * happened before it, so the current period starts there and the previous one has gaps.
 */
export function alignCompare<K extends string>(
  current: readonly ({ date: string } & Partial<Record<K, number | null>>)[],
  previous: readonly ({ date: string } & Partial<Record<K, number | null>>)[],
  periods: { current: DateRange; previous: DateRange | null },
  keys: readonly K[],
  { zero = [], first }: { zero?: readonly K[]; first?: string } = {},
): ({ date: string } & Record<K | `prev_${K}`, number | null>)[] {
  const now = new Map(current.map((r) => [r.date, r]));
  const before = new Map(previous.map((r) => [r.date, r]));
  const prev = periods.previous;
  const known = (date: string) => !first || date >= first;
  const read = (row: Partial<Record<K, number | null>> | undefined, key: K, date: string): number | null => row?.[key] ?? (known(date) && zero.includes(key) ? 0 : null);
  const days = eachDay({ start: first ? maxDate(first, periods.current.start) : periods.current.start, end: periods.current.end });
  return days.map((date) => {
    const row: Record<string, number | null> = {};
    const prevDate = prev ? addDays(prev.start, daysBetween(periods.current.start, date)) : null;
    for (const k of keys) {
      row[k] = read(now.get(date), k, date);
      if (prevDate && prev && prevDate <= prev.end) row[`prev_${k}`] = read(before.get(prevDate), k, prevDate);
      else row[`prev_${k}`] = null;
    }
    return { date, ...row } as { date: string } & Record<K | `prev_${K}`, number | null>;
  });
}

/** Search Console's measures, in the order the page shows them. */
export const PERFORMANCE_KEYS = ["clicks", "impressions", "ctr", "position"] as const;
export type PerformanceKey = (typeof PERFORMANCE_KEYS)[number];

type DailyMetrics = { date: string; clicks: number; impressions: number; position: number };

/**
 * Daily Search Console rows lined up for the charts. A day with no row is 0 clicks and 0 impressions, and
 * a gap for CTR and position: with no impressions behind them they have no value, which isn't the same as 0.
 */
export function performanceRows(current: readonly DailyMetrics[], previous: readonly DailyMetrics[], periods: Periods, first?: string) {
  const rates = (r: DailyMetrics) => ({
    date: r.date,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.impressions ? r.clicks / r.impressions : null,
    position: r.impressions ? r.position : null,
  });
  return alignCompare<PerformanceKey>(current.map(rates), previous.map(rates), periods, PERFORMANCE_KEYS, { zero: ["clicks", "impressions"], first });
}

export type PerformanceRow = ReturnType<typeof performanceRows>[number];
