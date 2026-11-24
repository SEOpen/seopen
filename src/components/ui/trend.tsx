"use client";

import { Fragment } from "react";
import { chooseChart, timeOf, weeklyBuckets, type SeriesPoint } from "@/lib/chart-rule";
import { formatNumber, formatPct, formatUsd } from "@/lib/format";
import { TimeChart } from "./time-chart";

/** `label` says when a reading was, in place of its day: "Nov 3, 2:05 PM" for two on one day. */
export type TrendPoint = SeriesPoint & { label?: string };

const FORMATS = {
  count: (v: number) => formatNumber(v),
  pct: (v: number) => formatPct(v),
  pct2: (v: number) => formatPct(v, 2),
  usd: (v: number) => formatUsd(v, 0),
  position: (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)),
  score: (v: number) => String(Math.round(v)),
} as const;

export type TrendFormat = keyof typeof FORMATS;

const dayOf = (date: string) => new Date(timeOf(date)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthOf = (date: string) => new Date(timeOf(date)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-secondary">{children}</p>;
}

/**
 * A series drawn as what it has earned, by the one rule in chart-rule.ts: nothing, a number and when the
 * chart starts, from → to, "no change", weekly columns, or a line. Takes a format's name rather than a
 * function, so a server component can use it.
 *
 * `counts`: a daily volume that adds up (clicks, sessions), not a level (position, score). `noun` names one
 * reading in the notes ("check", "crawl"). `monthly`: one reading a month, so nothing claims a particular
 * day. `misses`: tracked positions, where a null is a check that found nothing, so the chart marks it and
 * no note can call the keyword steady. `empty` shows when there's nothing at all.
 */
export function Trend({
  points,
  previous,
  label,
  previousLabel = "Previous period",
  counts = false,
  position = false,
  misses = false,
  monthly = false,
  format = "count",
  noun = "reading",
  height = 220,
  fill = false,
  table = true,
  empty = null,
}: {
  points: TrendPoint[];
  /** The same length before, lined up from the end. A line of its own, or a quiet filled column beside each column. */
  previous?: SeriesPoint[];
  label: string;
  previousLabel?: string;
  counts?: boolean;
  position?: boolean;
  misses?: boolean;
  monthly?: boolean;
  format?: TrendFormat;
  noun?: string;
  height?: number;
  /** A chart takes the height its parent's column has to give, down to `height`. */
  fill?: boolean;
  table?: boolean;
  empty?: React.ReactNode;
}) {
  const fmt = FORMATS[format];
  const day = monthly ? monthOf : dayOf;
  const when = (date: string) => points.find((p) => p.date === date)?.label ?? day(date);
  const choice = chooseChart(points, { counts, misses });
  switch (choice.kind) {
    case "empty":
      return <>{empty}</>;
    case "single":
      return (
        <Note>
          <span className="data text-fg">{fmt(choice.point.value)}</span> on {when(choice.point.date)}. The chart starts with the next {noun}.
        </Note>
      );
    case "few": {
      const readings = choice.middle ? [choice.first, choice.middle, choice.last] : [choice.first, choice.last];
      return (
        <Note>
          {readings.map((r, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <>
                  <span aria-hidden> → </span>
                  <span className="sr-only"> to </span>
                </>
              )}
              <span className={i === readings.length - 1 ? "data text-fg" : "data"}>{fmt(r.value)}</span>
              {readings.length > 2 ? " " : " on "}
              {when(r.date)}
            </Fragment>
          ))}
          .
        </Note>
      );
    }
    case "flat":
      return (
        <Note>
          No change across {formatNumber(choice.count)} {noun}s: <span className="data text-fg">{fmt(choice.value)}</span>.
        </Note>
      );
    case "number":
      return (
        <Note>
          <span className="data text-fg">{fmt(choice.total)}</span> in {points.length} days, too few to chart.
        </Note>
      );
  }

  // Lined up from the end, so a short earlier period leaves its oldest rows empty.
  const before = (i: number, length: number) => previous?.[(previous?.length ?? 0) - (length - i)]?.value ?? null;
  // From what's drawn, not what came in: a week with an unstored day has no earlier total, so a period with no whole week has nothing to key.
  const seriesOf = (rows: { previous: number | null }[]) => [{ key: "value", label }, ...(rows.some((r) => r.previous != null) ? [{ key: "previous", label: previousLabel, role: "previous" as const }] : [])];

  if (choice.kind === "columns") {
    const weekly = choice.bucket === "week";
    const data = weekly
      ? weeklyBuckets(points, previous).map((b) => ({ date: b.date, label: `${day(b.start)} to ${day(b.date)}`, value: b.value, previous: b.previous }))
      : points.map((p, i) => ({ date: p.date, value: p.value, previous: before(i, points.length) }));
    return <TimeChart data={data} series={seriesOf(data)} label={label} form="columns" monthly={monthly && !weekly} height={height} fill={fill} format={fmt} table={table} />;
  }

  const data = points.map((p, i) => {
    const label = monthly ? monthOf(p.date) : p.label;
    return { date: p.date, value: p.value, previous: before(i, points.length), ...(label ? { label } : {}) };
  });
  return <TimeChart data={data} series={seriesOf(data)} label={label} form={position ? "position" : "line"} dots={choice.dots} misses={misses} monthly={monthly} height={height} fill={fill} format={fmt} table={table} />;
}
