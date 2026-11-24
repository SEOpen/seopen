"use client";

import { useState, type ReactNode } from "react";
import { formatNumber } from "@/lib/format";
import { chartDay } from "./module-card";

const FORMATS = {
  count: (v: number) => formatNumber(v),
  position: (v: number) => v.toFixed(1),
} as const;

/** One line a screen reader hears instead of the plot: "Clicks, Sep 30 to Oct 27: latest 1, high 5, low 0". */
function seriesSummary(label: string, rows: Record<string, unknown>[], xKey: string, key: string, format: (v: number) => string, x: (v: unknown) => string = String): string {
  const values = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  if (!rows.length || !values.length) return `${label}: no data`;
  const span = rows.length > 1 ? `${x(rows[0][xKey])} to ${x(rows[rows.length - 1][xKey])}` : x(rows[0][xKey]);
  return `${label}, ${span}: latest ${format(values[values.length - 1])}, high ${format(Math.max(...values))}, low ${format(Math.min(...values))}`;
}

/**
 * A stat's trend: one line, no axes, a dot on the latest value, in the measurement colour whichever way
 * it went. The change beside it says better or worse, so the two can never contradict each other.
 * Drawn as plain SVG so it shows before hydration. Screen readers get a one-line summary ("Clicks,
 * Sep 30 to Oct 27: latest 1, high 5, low 0"); a pointer gets the day and value under it. `invert` puts low values at the top (positions). Needs 2+ values.
 *
 * `wide` fills its container. It stretches to any width, so its dot is an HTML element that keeps
 * its shape, and it lets a finger scroll the page. `fallback` shows instead when there's no trend to draw.
 */
export function Sparkline({
  points,
  label,
  color,
  format = "count",
  invert = false,
  wide = false,
  fallback = null,
  className,
}: {
  points: { date: string; value: number | null }[];
  label: string;
  /** Overrides the measurement colour. */
  color?: string;
  format?: keyof typeof FORMATS;
  invert?: boolean;
  wide?: boolean;
  fallback?: ReactNode;
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const fmt = FORMATS[format];
  const values = points.map((p) => p.value).filter((v): v is number => v != null && !Number.isNaN(v));
  // A line of zeros says nothing the "0" beside it doesn't.
  if (values.length < 2 || values.every((v) => v === 0)) return fallback;

  const stroke = color ?? "var(--series)";

  const W = wide ? 240 : 80;
  const H = wide ? 56 : 24;
  const PAD_X = wide ? 0 : 3;
  const PAD_Y = wide ? 4 : 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PAD_X + (i * (W - 2 * PAD_X)) / Math.max(points.length - 1, 1);
  // A flat series sits in the middle rather than on an edge.
  const y = (v: number) => (max === min ? H / 2 : invert ? PAD_Y + ((v - min) / span) * (H - 2 * PAD_Y) : H - PAD_Y - ((v - min) / span) * (H - 2 * PAD_Y));

  // Days with no value break the line instead of being drawn as zero.
  let d = "";
  let run = 0;
  const lone: number[] = [];
  points.forEach((p, i) => {
    if (p.value == null || Number.isNaN(p.value)) {
      if (run === 1) lone.push(i - 1);
      run = 0;
      return;
    }
    d += `${run ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
    run++;
  });
  if (run === 1) lone.push(points.length - 1);

  const lastIndex = points.findLastIndex((p) => p.value != null && !Number.isNaN(p.value));
  const marked = hover ?? lastIndex;
  const markedValue = points[marked]?.value;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const raw = Math.round((((e.clientX - box.left) / box.width) * W - PAD_X) / ((W - 2 * PAD_X) / Math.max(points.length - 1, 1)));
    // Snap to the nearest day that has a value.
    let best: number | null = null;
    points.forEach((p, i) => {
      if (p.value == null) return;
      if (best == null || Math.abs(i - raw) < Math.abs(best - raw)) best = i;
    });
    setHover(best);
  }

  const summary = seriesSummary(
    label,
    points.map((p) => ({ day: chartDay(p.date), v: p.value })),
    "day",
    "v",
    fmt,
  );

  const markedLeft = `${(x(marked) / W) * 100}%`;
  return (
    <span className={`relative ${wide ? "block" : "inline-block align-middle"} ${className ?? ""}`}>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${W} ${H}`}
        width={wide ? undefined : W}
        height={wide ? undefined : H}
        preserveAspectRatio={wide ? "none" : undefined}
        className={wide ? "block h-14 w-full touch-pan-y overflow-visible" : "block touch-none overflow-visible"}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {/* A reading with empty days either side would otherwise vanish. */}
        {!wide && lone.map((i) => <circle key={i} cx={x(i)} cy={y(points[i].value as number)} r={1.5} fill={stroke} />)}
        {!wide && markedValue != null && <circle cx={x(marked)} cy={y(markedValue)} r={2.5} fill={stroke} stroke="var(--surface)" strokeWidth={1.5} />}
      </svg>
      {wide && markedValue != null && (
        <span
          aria-hidden
          className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: markedLeft, top: `${(y(markedValue) / H) * 100}%`, background: stroke, boxShadow: "0 0 0 1.5px var(--surface)" }}
        />
      )}
      {hover != null && markedValue != null && (
        <span
          aria-hidden
          className="data pointer-events-none absolute top-full z-10 mt-1 -translate-x-1/2 rounded-md border border-control-edge bg-surface-2 px-1.5 py-0.5 text-xs! whitespace-nowrap text-fg"
          // The wide line runs to the card's edges, so the label stays inside them.
          style={{ left: wide ? `clamp(3rem, ${markedLeft}, calc(100% - 3rem))` : "50%" }}
        >
          <span className="text-muted">{chartDay(points[hover].date)}</span> {fmt(markedValue)}
        </span>
      )}
    </span>
  );
}
