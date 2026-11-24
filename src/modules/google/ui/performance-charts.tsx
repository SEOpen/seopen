"use client";

import { useState } from "react";
import { TimeChart, type ChartMark } from "@/components/ui/time-chart";
import { Trend, type TrendFormat } from "@/components/ui/trend";
import { chooseChart, type SeriesPoint } from "@/lib/chart-rule";
import { formatNumber, formatPct } from "@/lib/format";
import type { PerformanceKey, PerformanceRow } from "../windowing";

const METRICS: { key: PerformanceKey; label: string; counts: boolean; trend: TrendFormat; format: (v: number) => string; form: "line" | "position" }[] = [
  { key: "clicks", label: "Clicks", counts: true, trend: "count", format: (v) => formatNumber(v), form: "line" },
  { key: "impressions", label: "Impressions", counts: true, trend: "count", format: (v) => formatNumber(v), form: "line" },
  { key: "ctr", label: "CTR", counts: false, trend: "pct", format: (v) => formatPct(v), form: "line" },
  { key: "position", label: "Search Console position", counts: false, trend: "position", format: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)), form: "position" },
];

const HEIGHT = 180;

const pointsOf = (rows: PerformanceRow[], key: PerformanceKey | `prev_${PerformanceKey}`): SeriesPoint[] => rows.map((r) => ({ date: r.date, value: r[key] }));

/**
 * One chart per measure, because clicks and impressions differ by about 800 times and a shared axis would
 * flatten one of them. The line charts share a crosshair, so a day reads across all four. A measure that
 * hasn't earned a line takes what the chart rule gives it instead (a number, from → to, weekly columns).
 * `marks` are days to draw across the line charts, such as the days fixes went live on a page.
 */
export function PerformanceCharts({ rows, previousLabel = "Previous period", marks, markNoun }: { rows: PerformanceRow[]; previousLabel?: string; marks?: ChartMark[]; markNoun?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="grid gap-x-8 gap-y-6 @3xl/main:grid-cols-2">
      {METRICS.map((m) => {
        const points = pointsOf(rows, m.key);
        const before = pointsOf(rows, `prev_${m.key}`);
        const hasBefore = before.some((p) => p.value != null);
        const choice = chooseChart(points, { counts: m.counts });
        return (
          <div key={m.key} className="min-w-0">
            <h3 className="mb-2 text-sm font-medium">{m.label}</h3>
            {choice.kind === "line" ? (
              <TimeChart
                data={rows.map((r) => ({ date: r.date, value: r[m.key], previous: r[`prev_${m.key}`] }))}
                series={[{ key: "value", label: m.label }, ...(hasBefore ? [{ key: "previous", label: previousLabel, role: "previous" as const }] : [])]}
                label={m.label}
                form={m.form}
                dots={choice.dots}
                height={HEIGHT}
                format={m.format}
                hover={hover}
                onHover={setHover}
                marks={marks}
                markNoun={markNoun}
              />
            ) : (
              <Trend
                points={points}
                previous={hasBefore ? before : undefined}
                previousLabel={previousLabel}
                label={m.label}
                counts={m.counts}
                position={m.form === "position"}
                format={m.trend}
                noun="day"
                height={HEIGHT}
                empty={<p className="text-sm text-secondary">No impressions in this period, so nothing to chart.</p>}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
