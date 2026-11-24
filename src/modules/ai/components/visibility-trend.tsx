"use client";

import { TimeChart, type ChartRow, type ChartSeries } from "@/components/ui/time-chart";
import { Trend } from "@/components/ui/trend";
import { chooseChart, type SeriesPoint } from "@/lib/chart-rule";

const percent = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}%`;

const readings = (rows: ChartRow[], key: string): SeriesPoint[] => rows.map((r) => ({ date: r.date, value: typeof r[key] === "number" ? (r[key] as number) : null }));

/**
 * You against grey competitors, run by run, on a % axis. The usual rule decides whether it has earned a
 * chart: a flat line of yours still draws when a competitor moved, since that's the news then. Client-side
 * because the chart takes its number format as a function.
 */
export function VisibilityTrend({ rows, series, empty }: { rows: ChartRow[]; series: ChartSeries[]; empty?: React.ReactNode }) {
  const lined = series.map((s) => chooseChart(readings(rows, s.key))).filter((c) => c.kind === "line");
  if (!lined.length) {
    const points = readings(rows, "visibility").map((p) => ({ date: p.date, value: p.value == null ? null : p.value / 100 }));
    return <Trend points={points} label="Your visibility" format="pct" noun="run" table={false} empty={empty} />;
  }
  return <TimeChart data={rows} series={series} label="Share of answers naming each brand" dots={lined.some((c) => c.kind === "line" && c.dots)} height={260} format={percent} />;
}
