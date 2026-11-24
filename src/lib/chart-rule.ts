/**
 * What a series of numbers should be drawn as, and the date arithmetic the charts share. Pure, so the
 * rule is tested in one place and every page gets the same answer.
 */

export interface SeriesPoint {
  date: string;
  value: number | null;
}

export type ChartChoice =
  /** Nothing yet: say why, and one next step. No frame or axes. */
  | { kind: "empty" }
  /** One reading: the number, and when the chart starts. */
  | { kind: "single"; point: { date: string; value: number } }
  /** Two or three readings: the numbers in a row, with a third's middle one too, so a recent "no change" isn't hidden. A line through three dots says nothing more. */
  | { kind: "few"; first: { date: string; value: number }; middle?: { date: string; value: number }; last: { date: string; value: number } }
  /** Every reading the same: "No change across N checks". */
  | { kind: "flat"; count: number; value: number }
  /** A count too small to chart. */
  | { kind: "number"; total: number }
  /** Sparse counts, summed so a zigzag of integers doesn't read as a trend. */
  | { kind: "columns"; bucket: "day" | "week" }
  | { kind: "line"; dots: boolean };

/**
 * `counts`: the values are a daily volume that adds up (clicks, sessions), not a level (position, score).
 * Only counts are summed into columns.
 *
 * `misses`: a null is a check that ran and didn't find the keyword, not a missing reading. The gaps are
 * then part of the story, so any null goes straight to a line that marks them: the text forms read only
 * the real values, and would call a keyword that fell out of the results steady. Search Console's nulls
 * are days with no impressions, which is no reading at all, so it leaves this off.
 */
export function chooseChart(points: SeriesPoint[], { counts = false, misses = false }: { counts?: boolean; misses?: boolean } = {}): ChartChoice {
  const real = points.filter((p): p is { date: string; value: number } => p.value != null && !Number.isNaN(p.value));
  if (!real.length) return { kind: "empty" };
  if (misses && real.length < points.length) return { kind: "line", dots: points.length <= 7 };
  if (real.length === 1) return { kind: "single", point: real[0] };
  // Before "few", because "82 → 82" reads like a change.
  if (real.every((p) => p.value === real[0].value)) return { kind: "flat", count: real.length, value: real[0].value };
  if (real.length === 3) return { kind: "few", first: real[0], middle: real[1], last: real[2] };
  if (real.length === 2) return { kind: "few", first: real[0], last: real[1] };
  if (counts) {
    const total = real.reduce((n, p) => n + p.value, 0);
    if (total < 5) return { kind: "number", total };
    if (total / real.length < 5) return { kind: "columns", bucket: real.length <= 7 ? "day" : "week" };
  }
  return { kind: "line", dots: real.length <= 7 };
}

/**
 * Whether several series on one axis have earned a chart, by the same rule as one. The first series is
 * the one being read, and only its nulls can be misses: another site's are just "not seen". Any series
 * with a line's worth of change earns the chart, because a flat line of yours is still worth drawing when
 * a competitor moved. Otherwise nothing has moved enough to draw, and the first series reads as text.
 */
export function chooseLines(series: SeriesPoint[][], { misses = false }: { misses?: boolean } = {}): { kind: "chart"; dots: boolean } | { kind: "text" } {
  const lined = series.some((points, i) => chooseChart(points, { misses: misses && i === 0 }).kind === "line");
  return lined ? { kind: "chart", dots: (series[0]?.length ?? 0) <= 7 } : { kind: "text" };
}

/**
 * The entries in a chart's key. Context lines are all the same thin grey, so a list of their names can't
 * connect a name to a line: two or more share one "Competitors" entry, and the names stay in the hover and
 * the table. A single context line keeps its name, since it can only be that line.
 */
export function legendSeries<S extends { label: string; role?: string }>(series: S[]): S[] {
  const context = series.filter((s) => s.role === "context");
  if (context.length < 2) return series;
  return series.filter((s) => s.role !== "context" || s === context[0]).map((s) => (s === context[0] ? { ...s, label: "Competitors" } : s));
}

/** Milliseconds for a calendar day (read as UTC, so it never shifts) or an ISO instant. */
export function timeOf(date: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) : new Date(date).getTime();
}

const DAY = 86_400_000;

export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every day from `start` to `end`, with a value from `rows` or `fill`. A synced day with no row had no
 * activity, so it's 0; a day outside what's synced should be passed as null.
 */
export function fillDays<T extends { date: string }>(rows: T[], start: string, end: string, read: (row: T) => number | null, fill: number | null = 0): SeriesPoint[] {
  const byDate = new Map(rows.map((r) => [r.date.slice(0, 10), r]));
  const out: SeriesPoint[] = [];
  for (let t = timeOf(start.slice(0, 10)); t <= timeOf(end.slice(0, 10)); t += DAY) {
    const key = dayKey(t);
    const row = byDate.get(key);
    out.push({ date: key, value: row ? read(row) : fill });
  }
  return out;
}

export interface WeekBucket {
  /** The bucket's last day. */
  date: string;
  /** The bucket's first day. */
  start: string;
  /** Null when any day of the week isn't stored. */
  value: number | null;
  /** Null when there's no earlier week, or any day of it isn't stored. */
  previous: number | null;
}

/**
 * Sums daily counts into 7-day buckets counted back from the last day, so the newest column is always a
 * full week. `previous` is the same-length run before it, compared bucket by bucket from the end. A short
 * first bucket is left out: a column for three days would look like a fall. For the same reason a week
 * with a null day has no total: a null is a day nobody stored, and summing it as 0 would draw a false
 * reading. A stored day with no activity is a 0, which still counts.
 */
export function weeklyBuckets(days: { date: string; value: number | null }[], previous?: { date: string; value: number | null }[]): WeekBucket[] {
  const out: WeekBucket[] = [];
  const sum = (rows: { value: number | null }[]) => rows.reduce<number | null>((n, r) => (n == null || r.value == null ? null : n + r.value), 0);
  for (let end = days.length; end - 7 >= 0; end -= 7) {
    const slice = days.slice(end - 7, end);
    const back = days.length - end;
    const prevEnd = previous ? previous.length - back : 0;
    const prevSlice = previous && prevEnd - 7 >= 0 ? previous.slice(prevEnd - 7, prevEnd) : null;
    out.unshift({ date: slice[6].date, start: slice[0].date, value: sum(slice), previous: prevSlice ? sum(prevSlice) : null });
  }
  return out;
}

/** Round ticks from zero to just past the largest value, about four steps: 0, 2 … 8. Whole steps for counts. */
export function niceTicks(max: number, whole: boolean): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = (whole ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  if (whole) step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step * 1e6) / 1e6);
}

/**
 * Ticks for a position axis: 1 at the top, then the page boundaries that fall inside the range. An average
 * position has no ceiling, so past 100 the axis runs on in round steps to cover it. There the page marks
 * would sit on top of each other.
 */
export function positionTicks(worst: number): number[] {
  if (worst > 100) return [1, ...niceTicks(worst, true).slice(1)];
  const marks = [1, 10, 20, 50, 100];
  const top = marks.find((m) => m >= worst) ?? 100;
  return marks.filter((m) => m <= top);
}

const fmt = (ms: number, withYear: boolean) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: withYear ? undefined : "numeric", year: withYear ? "numeric" : undefined, timeZone: "UTC" });

/** Labelled dates on the ruler: real calendar marks that fit the width, never evenly spaced guesses. */
export function rulerLabels(startMs: number, endMs: number, width: number): { t: number; label: string }[] {
  if (!(endMs > startMs)) return [{ t: startMs, label: fmt(startMs, false) }];
  const span = (endMs - startMs) / DAY;
  const room = Math.max(2, Math.floor(width / 76));
  const out: { t: number; label: string }[] = [];
  if (span > 130) {
    // Months, thinned to what fits. The year shows on January, and on a run longer than a year.
    const months: number[] = [];
    const d = new Date(startMs);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (d.getUTCDate() > 1 ? 1 : 0), 1);
    while (t <= endMs) {
      months.push(t);
      const m = new Date(t);
      t = Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1);
    }
    const every = Math.max(1, Math.ceil(months.length / room));
    months.forEach((m, i) => {
      if (i % every === 0) out.push({ t: m, label: new Date(m).getUTCMonth() === 0 || span > 400 ? fmt(m, true) : new Date(m).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) });
    });
    return out;
  }
  // Days: a step of 1, 2, 7, 14 or 28 days that fits, counted back from the end so the last date is labelled.
  const step = [1, 2, 7, 14, 28].find((s) => span / s + 1 <= room) ?? 56;
  for (let t = endMs; t >= startMs; t -= step * DAY) out.unshift({ t, label: fmt(t, false) });
  return out;
}

/**
 * "Clicks, Sep 30 to Oct 27: latest 1, high 5, low 0": what a screen reader hears instead of the plot.
 * `missed` names what a null means when it's a reading of its own ("not found"), so the summary can't
 * give an old position as the latest when the newest check found nothing. `monthly`: one reading a
 * month, named by month and year ("Nov 2024 to Oct 2026"). Days carry their year when the span crosses one.
 */
export function chartSummary(label: string, points: SeriesPoint[], format: (v: number) => string, missed?: string, monthly = false): string {
  const values = points.map((p) => p.value).filter((v): v is number => v != null && !Number.isNaN(v));
  if (!values.length) return points.length && missed ? `${label}: ${missed} in any check` : `${label}: no data`;
  const first = timeOf(points[0].date);
  const last = timeOf(points[points.length - 1].date);
  const years = new Date(first).getUTCFullYear() !== new Date(last).getUTCFullYear();
  const day = (t: number) =>
    monthly ? fmt(t, true) : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: years ? "numeric" : undefined, timeZone: "UTC" });
  const span = points.length > 1 ? `${day(first)} to ${day(last)}` : day(first);
  const misses = missed ? points.length - values.length : 0;
  const latest = misses && points[points.length - 1].value == null ? missed : format(values[values.length - 1]);
  const range = `latest ${latest}, high ${format(Math.max(...values))}, low ${format(Math.min(...values))}`;
  return `${label}, ${span}: ${range}${misses ? `, ${missed} in ${misses} of ${points.length} checks` : ""}`;
}
