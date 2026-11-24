"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { chartSummary, legendSeries, niceTicks, positionTicks, rulerLabels, timeOf } from "@/lib/chart-rule";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type ChartRow = { date: string } & Record<string, string | number | null | undefined>;

export interface ChartSeries {
  key: string;
  label: string;
  /**
   * primary: the measurement, the brand blue. previous: the period before, dashed. context: competitors, thin
   * and neutral, one entry in the key and named in the hover and table. entity: one of up to four named
   * series, keyed by `color`.
   */
  role?: "primary" | "previous" | "context" | "entity";
  /** For role "entity": the entity's own colour, so filtering never repaints the survivors. */
  color?: string;
}

const STROKE: Record<NonNullable<ChartSeries["role"]>, string> = {
  primary: "var(--series)",
  previous: "var(--line-strong)",
  context: "var(--line-strong)",
  entity: "var(--chart-1)",
};

const stroke = (s: ChartSeries) => s.color ?? STROKE[s.role ?? "primary"];

/** A day something happened, such as a fix going live, drawn as a dashed line across the plot. */
export interface ChartMark {
  /** A date in `data`, "YYYY-MM-DD". */
  date: string;
  label: string;
}

/** The marks on one row's date, for the tooltip, the readout and the table. */
export const marksOn = (marks: ChartMark[], date: string) => marks.filter((m) => m.date === date);

/** "Fix live on Nov 3: Title is too long", for the chart's summary. Marks outside the data say nothing. */
export function marksSummary(marks: ChartMark[], data: ChartRow[], noun: string): string {
  const shown = marks.filter((m) => data.some((r) => r.date === m.date));
  return shown.map((m) => `${noun} on ${dayLabel(m.date)}: ${m.label}`).join(". ");
}
const order = (s: ChartSeries) => (s.role === "primary" || !s.role ? 0 : s.role === "entity" ? 1 : s.role === "previous" ? 2 : 3);

const LEFT = 44;
const RIGHT = 12;
const TOP = 10;
const BOTTOM = 34;
const FINE_MIN_GAP = 6;
const DAY = 86_400_000;

function dayLabel(date: string) {
  const hasTime = !/^\d{4}-\d{2}-\d{2}$/.test(date);
  return new Date(timeOf(date)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: hasTime ? "numeric" : undefined, minute: hasTime ? "2-digit" : undefined, timeZone: hasTime ? undefined : "UTC" });
}

/**
 * What the value axis has to reach. `yMax` holds it higher so charts side by side share a scale. A rank
 * axis runs on its own page marks, so it ignores that.
 */
export function axisMax(values: number[], position: boolean, yMax?: number): number {
  return Math.max(position ? 0 : (yMax ?? 0), ...values, 0);
}

/** A column is a thin mark whatever room it has: the leftover is air. */
const COLUMN_MAX = 16;
const COLUMN_MIN = 3;
const PREVIOUS_GAP = 2;

/**
 * How wide a column, and the quiet one beside it for the period before, in a bucket this wide. The two
 * stand apart, so the earlier mark never crosses the bar. The pair keeps to about 70% of the bucket until
 * the columns reach their floor.
 */
export function columnWidths(bucket: number, paired: boolean): { bar: number; previous: number; gap: number } {
  const room = bucket * 0.7;
  if (!paired) return { bar: Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, room)), previous: 0, gap: 0 };
  const bar = Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, ((room - PREVIOUS_GAP) * 2) / 3));
  return { bar, previous: Math.max(2, bar / 2), gap: PREVIOUS_GAP };
}

/** A column from the baseline up, square at the bottom and rounded at the top. Open at the bottom when `closed` is false. */
export function columnPath(left: number, width: number, top: number, baseline: number, closed = true): string {
  const radius = Math.min(4, baseline - top, width / 2);
  const right = left + width;
  return `M${left},${baseline}V${top + radius}Q${left},${top} ${left + radius},${top}H${right - radius}Q${right},${top} ${right},${top + radius}V${baseline}${closed ? "Z" : ""}`;
}

/**
 * The one time chart. A real time scale, so irregular crawls and runs space honestly; straight segments
 * with a break at every null; a ruler drawn from the dates; a crosshair the arrow keys also drive; a
 * table view. Three forms:
 *   line      a level or a healthy daily volume. `dots` marks every point of a short series.
 *   columns   sparse counts, thin, each with a quiet filled column beside it for the period before.
 *   position  an inverted rank axis with page one marked. With `misses`, a null on the first series is a
 *             check that found nothing, marked along the bottom and named in the key, hover and table.
 *             Without it, a null is only a gap: Search Console has no reading on a day with no impressions.
 * Which form a series deserves is chooseChart's call (src/lib/chart-rule.ts), not the page's.
 *
 * Drawn in plain SVG at the measured width: no animation, and one tab stop for the whole plot.
 */
export function TimeChart({
  data,
  series,
  label,
  form = "line",
  dots = false,
  misses = false,
  monthly = false,
  height = 220,
  fill = false,
  yMax,
  format = (v) => formatNumber(v),
  axisFormat,
  hover,
  onHover,
  table = true,
  marks = [],
  markNoun = "Marked",
}: {
  data: ChartRow[];
  series: ChartSeries[];
  /** What it measures, for the summary and the table's head. */
  label: string;
  form?: "line" | "columns" | "position";
  dots?: boolean;
  /** For form "position": the check ran and a null means it found nothing. See the form's note above. */
  misses?: boolean;
  /** One reading a month: the summary names months and years, not days. */
  monthly?: boolean;
  height?: number;
  /** Takes the height its parent's flex column has to give, down to `height`, so a chart beside a taller rail leaves no void. */
  fill?: boolean;
  /** Holds the value axis at least this high, so small multiples can be compared. Not for form "position". */
  yMax?: number;
  format?: (v: number) => string;
  axisFormat?: (v: number) => string;
  /** Controlled crosshair, for small multiples that share one. An index into `data`. */
  hover?: number | null;
  onHover?: (index: number | null) => void;
  table?: boolean;
  /** Days to mark across the plot, with what happened. Named in the key, the hover, the table and the summary. */
  marks?: ChartMark[];
  /** What a mark is, in the key and the summary: "Fix live". */
  markNoun?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [boxHeight, setBoxHeight] = useState(0);
  const [ownHover, setOwnHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [spoken, setSpoken] = useState("");
  const active = hover !== undefined ? hover : ownHover;
  const setActive = onHover ?? setOwnHover;

  useIsoLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    setBoxHeight(el.clientHeight);
    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
      setBoxHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable]);

  const times = useMemo(() => data.map((r) => timeOf(r.date)), [data]);
  const start = times[0] ?? 0;
  const end = times[times.length - 1] ?? 0;
  const plotW = Math.max(0, width - LEFT - RIGHT);
  const drawnHeight = fill ? Math.max(height, boxHeight) : height;
  const plotH = drawnHeight - TOP - BOTTOM;
  const drawn = series.filter((s) => s.role !== "previous");

  // Columns need half a bucket's room at each end, so the first and last don't hang over the axis.
  const bucketMs = times.length > 1 ? (end - start) / (times.length - 1) : DAY;
  const pad = form === "columns" ? bucketMs / 2 : 0;
  const x = (t: number) => (end + pad === start - pad ? LEFT + plotW / 2 : LEFT + ((t - (start - pad)) / (end + pad - (start - pad))) * plotW);

  const values = data.flatMap((r) => series.map((s) => r[s.key]).filter((v): v is number => typeof v === "number" && !Number.isNaN(v)));
  const position = form === "position";
  const maxV = axisMax(values, position, yMax);
  const ticks = position ? positionTicks(Math.max(maxV, 20)) : niceTicks(maxV, values.every(Number.isInteger));
  const lo = position ? 1 : 0;
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => {
    const f = (v - lo) / (hi - lo || 1);
    return position ? TOP + f * plotH : TOP + (1 - f) * plotH;
  };

  // One tick per reading when they stand clear of each other; weekly otherwise; none rather than a false scale.
  const fine = useMemo(() => {
    if (!plotW || times.length < 2) return [] as number[];
    const gap = plotW / (times.length - 1 + (form === "columns" ? 1 : 0));
    if (gap >= FINE_MIN_GAP) return times;
    const span = (end - start) / DAY;
    if ((plotW / span) * 7 < FINE_MIN_GAP) return [];
    const out: number[] = [];
    for (let t = end; t >= start; t -= 7 * DAY) out.push(t);
    return out;
  }, [plotW, times, start, end, form]);

  const labels = useMemo(() => (plotW ? rulerLabels(start, end, plotW) : []), [start, end, plotW]);

  // Whose nulls are checks that found nothing. Rivals' are only "not seen", so they aren't marked.
  const missKey = position && misses ? drawn[0]?.key : undefined;
  const hasMisses = !!missKey && data.some((r) => r[missKey] == null);

  const marked = marks.filter((m) => data.some((r) => r.date === m.date));
  const summary = [drawn.map((s) => chartSummary(s.label, data.map((r) => ({ date: r.date, value: typeof r[s.key] === "number" ? (r[s.key] as number) : null })), format, s.key === missKey ? "not found" : undefined, monthly)).join(". "), marksSummary(marked, data, markNoun)].filter(Boolean).join(". ");

  const sorted = [...series].sort((a, b) => order(a) - order(b));

  function nearest(px: number) {
    let best = 0;
    let dist = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(x(t) - px);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  }

  function onMove(e: PointerEvent<SVGSVGElement>) {
    setActive(nearest(e.clientX - e.currentTarget.getBoundingClientRect().left));
  }

  function onKey(e: KeyboardEvent) {
    const last = data.length - 1;
    const cur = active ?? last;
    let next: number;
    if (e.key === "ArrowLeft") next = Math.max(0, cur - 1);
    else if (e.key === "ArrowRight") next = Math.min(last, cur + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") {
      setSpoken("");
      return setActive(null);
    } else return;
    e.preventDefault();
    setActive(next);
    // Only from the keyboard: a pointer sweeping the chart would talk over everything.
    const notes = marksOn(marked, data[next].date).map((m) => `${markNoun}: ${m.label}`);
    setSpoken([chartReadout(data[next], sorted, format, missKey), ...notes].join(". "));
  }

  const activeRow = active != null ? data[active] : null;
  const activeX = active != null ? x(times[active]) : 0;

  return (
    <figure className={cn("min-w-0", fill && "flex min-h-0 flex-1 flex-col")}>
      {(series.length > 1 || hasMisses || marked.length > 0) && (
        <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          {legendSeries(sorted).map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              {form === "columns" ? (
                <span aria-hidden className="size-2 shrink-0 rounded-t-[2px] border" style={s.role === "previous" ? { background: "var(--tick)", borderColor: "var(--tick)" } : { background: stroke(s), borderColor: stroke(s) }} />
              ) : (
                <svg aria-hidden width="16" height="2" className="shrink-0">
                  <line x1="0" y1="1" x2="16" y2="1" stroke={stroke(s)} strokeWidth="2" strokeDasharray={s.role === "previous" ? "4 3" : undefined} />
                </svg>
              )}
              {s.label}
            </span>
          ))}
          {hasMisses && (
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="2" height="10" className="shrink-0">
                <line x1="1" y1="0" x2="1" y2="10" stroke="var(--bad)" strokeWidth="2" />
              </svg>
              Not found in that check
            </span>
          )}
          {marked.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <svg aria-hidden width="2" height="10" className="shrink-0">
                <line x1="1" y1="0" x2="1" y2="10" stroke="var(--tick-major)" strokeWidth="1.5" strokeDasharray="2 2" />
              </svg>
              {markNoun}
            </span>
          )}
        </figcaption>
      )}
      {asTable ? (
        <ChartTable data={data} series={series} format={format} label={label} missKey={missKey} marks={marked} markNoun={markNoun} />
      ) : (
        <div
          ref={box}
          role="group"
          tabIndex={0}
          aria-label={`${summary}. Use the arrow keys to read each date.`}
          onKeyDown={onKey}
          onBlur={() => {
            setSpoken("");
            setActive(null);
          }}
          className={cn("relative rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent", fill && "flex-1")}
          style={fill ? { minHeight: height } : { height }}
        >
          {width > 0 && (
            // Out of flow when it fills, so a drawn height can't hold the box open once the rail beside it shrinks.
            <svg width={width} height={drawnHeight} className={cn("block touch-pan-y", fill && "absolute inset-0")} aria-hidden onPointerMove={onMove} onPointerLeave={() => setActive(null)}>
              {position && hi >= 10.5 && (
                <g>
                  <rect x={LEFT} y={y(1)} width={plotW} height={y(10.5) - y(1)} fill="var(--zone)" />
                  <line x1={LEFT} x2={LEFT + plotW} y1={y(10.5)} y2={y(10.5)} stroke="var(--zone-line)" />
                  {/* Past 100 the band is too thin to hold its label, so the label sits under it. */}
                  <text x={LEFT + plotW - 4} y={hi > 100 ? y(10.5) + 13 : y(10.5) - 5} textAnchor="end" className="fill-muted text-[11px]">
                    Page one
                  </text>
                </g>
              )}
              {ticks.map((t) => (
                <g key={t}>
                  {!(position && t === 10) && <line x1={LEFT} x2={LEFT + plotW} y1={y(t)} y2={y(t)} stroke="var(--line)" />}
                  <text x={LEFT - 8} y={y(t) + 4} textAnchor="end" className="fill-muted font-mono text-[11px]">
                    {(axisFormat ?? format)(t)}
                  </text>
                </g>
              ))}

              {form === "columns" ? (
                <Columns data={data} times={times} x={x} y={y} baseline={y(0)} primary={drawn[0] ?? series[0]} previous={series.find((s) => s.role === "previous")} bucket={plotW / Math.max(1, data.length)} active={active} />
              ) : (
                [...series].sort((a, b) => order(b) - order(a)).map((s) => <Lines key={s.key} data={data} times={times} series={s} x={x} y={y} dots={dots} />)
              )}

              {/* Marked days, under the crosshair: dashed, so they never read as a series. */}
              {marked.map((m) => {
                const i = data.findIndex((r) => r.date === m.date);
                return <line key={`${m.date}-${m.label}`} x1={x(times[i])} x2={x(times[i])} y1={TOP} y2={TOP + plotH} stroke="var(--tick-major)" strokeWidth="1.5" strokeDasharray="3 3" />;
              })}

              {/* Not found: a mark along the bottom, so a gap in the line can't read as still there. */}
              {missKey && data.map((r, i) => (r[missKey] == null ? <line key={i} x1={x(times[i])} x2={x(times[i])} y1={TOP + plotH - 5} y2={TOP + plotH} stroke="var(--bad)" strokeWidth="1.5" /> : null))}

              {/* The ruler: fine ticks where there's a reading, major ticks on the labelled dates. */}
              <line x1={LEFT} x2={LEFT + plotW} y1={TOP + plotH + 0.5} y2={TOP + plotH + 0.5} stroke="var(--line-strong)" />
              {fine.map((t) => (
                <line key={t} x1={x(t)} x2={x(t)} y1={TOP + plotH} y2={TOP + plotH + 4} stroke="var(--tick)" />
              ))}
              {labels.map((l) => {
                const lx = x(l.t);
                const anchor = lx < LEFT + 24 ? "start" : lx > LEFT + plotW - 24 ? "end" : "middle";
                return (
                  <g key={l.t}>
                    <line x1={lx} x2={lx} y1={TOP + plotH} y2={TOP + plotH + 7} stroke="var(--tick-major)" />
                    <text x={lx} y={TOP + plotH + 22} textAnchor={anchor} className="fill-muted font-mono text-[11px]">
                      {l.label}
                    </text>
                  </g>
                );
              })}

              {active != null && form !== "columns" && (
                <g>
                  <line x1={activeX} x2={activeX} y1={TOP} y2={TOP + plotH} stroke="var(--tick-major)" />
                  {series.map((s) => {
                    const v = data[active][s.key];
                    return typeof v === "number" ? <circle key={s.key} cx={activeX} cy={y(v)} r="4" fill={stroke(s)} stroke="var(--surface)" strokeWidth="2" /> : null;
                  })}
                </g>
              )}
            </svg>
          )}
          {activeRow && <Tip row={activeRow} series={sorted} format={format} left={activeX} width={width} missKey={missKey} notes={marksOn(marked, activeRow.date).map((m) => `${markNoun}: ${m.label}`)} />}
          <div aria-live="polite" className="sr-only">
            {spoken}
          </div>
        </div>
      )}
      {table && (
        <div className="mt-1 flex justify-end">
          <button type="button" onClick={() => setAsTable(!asTable)} className="min-h-6 rounded-sm text-xs text-muted underline-offset-3 pointer-coarse:min-h-11 hover:text-fg hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {asTable ? "Show as chart" : "Show as table"}
          </button>
        </div>
      )}
    </figure>
  );
}

function Lines({ data, times, series: s, x, y, dots }: { data: ChartRow[]; times: number[]; series: ChartSeries; x: (t: number) => number; y: (v: number) => number; dots: boolean }) {
  const color = stroke(s);
  const quiet = s.role === "previous" || s.role === "context";
  // Straight segments, broken at every null. A point with no neighbour is a dot, or it would vanish.
  let d = "";
  let run = 0;
  const lone: number[] = [];
  data.forEach((r, i) => {
    const v = r[s.key];
    if (typeof v !== "number") {
      if (run === 1) lone.push(i - 1);
      run = 0;
      return;
    }
    d += `${run ? "L" : "M"}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`;
    run++;
  });
  if (run === 1) lone.push(data.length - 1);
  const lastIdx = data.findLastIndex((r) => typeof r[s.key] === "number");
  const marks = dots ? data.flatMap((r, i) => (typeof r[s.key] === "number" ? [i] : [])) : quiet || lastIdx < 0 ? [] : [lastIdx];
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeWidth={quiet ? 1.5 : 2} strokeDasharray={s.role === "previous" ? "4 4" : undefined} strokeLinejoin="round" />
      {[...new Set([...lone, ...marks])].map((i) => (
        <circle key={i} cx={x(times[i])} cy={y(data[i][s.key] as number)} r={quiet ? 2.5 : 3.5} fill={color} stroke="var(--surface)" strokeWidth="2" />
      ))}
    </g>
  );
}

function Columns({ data, times, x, y, baseline, primary, previous, bucket, active }: { data: ChartRow[]; times: number[]; x: (t: number) => number; y: (v: number) => number; baseline: number; primary: ChartSeries; previous?: ChartSeries; bucket: number; active: number | null }) {
  const { bar, previous: before, gap } = columnWidths(bucket, !!previous);
  // The pair sits centred on its date: the period before on the left, this one on the right.
  const offset = (before + gap + bar) / 2;
  return (
    <g>
      {data.map((r, i) => {
        const v = r[primary.key];
        const p = previous ? r[previous.key] : null;
        const cx = x(times[i]);
        const top = typeof v === "number" ? y(v) : baseline;
        return (
          <g key={r.date} opacity={active == null || active === i ? 1 : 0.55}>
            {/* A filled Chart mark, not an outline: on sparse days a tall outline read as a glitch beside a short bar. */}
            {typeof p === "number" && y(p) < baseline && <path d={columnPath(cx - offset, before, y(p), baseline)} fill="var(--tick)" />}
            {top < baseline && <path d={columnPath(cx + offset - bar, bar, top, baseline)} fill={stroke(primary)} />}
          </g>
        );
      })}
    </g>
  );
}

const rowLabel = (row: ChartRow) => (typeof row.label === "string" ? row.label : dayLabel(row.date));

/** What the tooltip says, as one line for a screen reader. */
export function chartReadout(row: ChartRow, series: ChartSeries[], format: (v: number) => string, missKey?: string) {
  const values = series.map((s) => {
    const v = row[s.key];
    return `${s.label} ${typeof v === "number" ? format(v) : s.key === missKey ? "not found" : "no data"}`;
  });
  return `${rowLabel(row)}: ${values.join(", ")}`;
}

function Tip({ row, series, format, left, width, missKey, notes = [] }: { row: ChartRow; series: ChartSeries[]; format: (v: number) => string; left: number; width: number; missKey?: string; notes?: string[] }) {
  const label = rowLabel(row);
  // Stays inside the plot: flips to the crosshair's left past the middle.
  const flip = left > width / 2;
  return (
    <div aria-hidden className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-control-edge bg-surface-2 px-2.5 py-2 font-mono text-xs" style={flip ? { right: width - left + 10 } : { left: left + 10 }}>
      <div className="text-muted">{label}</div>
      <ul className="mt-1 space-y-0.5">
        {series.map((s) => {
          const v = row[s.key];
          return (
            <li key={s.key} className="flex items-baseline justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-secondary">
                <span aria-hidden className="h-0.5 w-2.5 shrink-0" style={{ background: stroke(s) }} />
                {s.label}
              </span>
              {typeof v !== "number" && s.key === missKey ? <span className="text-fg">Not found</span> : <span className="data text-fg">{typeof v === "number" ? format(v) : "–"}</span>}
            </li>
          );
        })}
      </ul>
      {notes.map((n) => (
        <p key={n} className="mt-1.5 max-w-56 font-sans text-secondary">
          {n}
        </p>
      ))}
    </div>
  );
}

function ChartTable({ data, series, format, label, missKey, marks = [], markNoun }: { data: ChartRow[]; series: ChartSeries[]; format: (v: number) => string; label: string; missKey?: string; marks?: ChartMark[]; markNoun?: string }) {
  return (
    <div className="max-h-72 overflow-auto rounded-sm border border-line-soft">
      <table className="w-full text-sm">
        <caption className="sr-only">{label} by date</caption>
        <thead className="table-head sticky top-0 bg-surface">
          <tr>
            <th scope="col" className="h-8 px-3 text-left font-medium">
              Date
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="h-8 px-3 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.date} className="border-t border-line-soft">
              <td className="px-3 py-1.5 text-secondary">
                {typeof r.label === "string" ? r.label : dayLabel(r.date)}
                {marksOn(marks, r.date).map((m) => (
                  <span key={m.label} className="block text-xs text-muted">
                    {markNoun}: {m.label}
                  </span>
                ))}
              </td>
              {series.map((s) => {
                const v = r[s.key];
                const missed = typeof v !== "number" && s.key === missKey;
                return (
                  <td key={s.key} className={cn("px-3 py-1.5 text-right", !missed && "data", typeof v === "number" ? "text-fg" : "text-muted")}>
                    {typeof v === "number" ? format(v) : missed ? "Not found" : "–"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
