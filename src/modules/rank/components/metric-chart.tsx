"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { TimeChart, type ChartRow, type ChartSeries } from "@/components/ui/time-chart";
import { Trend, type TrendFormat } from "@/components/ui/trend";
import { chooseLines, type SeriesPoint } from "@/lib/chart-rule";
import { formatNumber, formatPct } from "@/lib/format";

export type MetricFormat = "pct" | "number" | "position";

export interface ChartMetric {
  key: string;
  label: string;
  format: MetricFormat;
  /** Rows like { date: "2026-10-29", alphanote: 0.12 }. */
  data: Record<string, string | number | null>[];
  /** `role` and `color` as on TimeChart: the site you're reading in the brand blue, the others thin and neutral. */
  series: ({ key: string; label: string } & Pick<ChartSeries, "role" | "color">)[];
}

export function formatMetric(v: unknown, format: MetricFormat): string {
  if (v == null || Number.isNaN(Number(v))) return "–";
  const n = Number(v);
  if (format === "pct") return `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}%`;
  if (format === "position") return n.toFixed(1);
  return formatNumber(n);
}

/** Small shares need two decimals to read as anything but 0.0%, and every tick and label should agree. */
function pctDigits(m: ChartMetric): 1 | 2 {
  const max = Math.max(0, ...m.data.flatMap((r) => m.series.map((s) => Number(r[s.key]))).filter(Number.isFinite));
  return max < 0.1 ? 2 : 1;
}

function trendFormat(m: ChartMetric): TrendFormat {
  if (m.format === "position") return "position";
  if (m.format === "number") return "count";
  return pctDigits(m) === 2 ? "pct2" : "pct";
}

/**
 * Several lines on one axis, once the chart rule says they've earned it (chooseLines). Until then, the
 * site being read in words, by the same rule as one series. A set with no such site, like Top 3, 10, 20,
 * reads every series, since none of them speaks for the others.
 */
function Lines({ metric: m, height }: { metric: ChartMetric; height: number }) {
  const misses = m.format === "position";
  const primary = m.series.find((s) => s.role === "primary");
  const lead = primary ?? m.series[0];
  if (!lead) return null;
  const points = (key: string): SeriesPoint[] => m.data.map((r) => ({ date: String(r.date), value: typeof r[key] === "number" ? (r[key] as number) : null }));
  const choice = chooseLines([lead, ...m.series.filter((s) => s !== lead)].map((s) => points(s.key)), { misses });

  if (choice.kind === "text") {
    return (
      <dl className="grid gap-1.5">
        {(primary ? [primary] : m.series).map((s) => (
          <div key={s.key} className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-sm text-muted [overflow-wrap:anywhere]">{s.label}</dt>
            <dd className="min-w-0">
              <Trend
                points={points(s.key)}
                label={s.label}
                format={trendFormat(m)}
                position={misses}
                misses={misses && s === lead}
                noun="check"
                empty={<p className="text-sm text-secondary">{misses ? "Not in the results checked." : "No checks in this range."}</p>}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const digits = pctDigits(m);
  const format = m.format === "pct" ? (v: number) => formatPct(v, digits) : (v: number) => formatMetric(v, m.format);
  return <TimeChart data={m.data as ChartRow[]} series={m.series} label={m.label} form={misses ? "position" : "line"} dots={choice.dots} misses={misses} height={height} format={format} />;
}

/** A measure over time, with a switcher when there's more than one. One series or several follow the chart-or-number rule. */
export function MetricChart({ metrics, height = 240 }: { metrics: ChartMetric[]; height?: number }) {
  const [active, setActive] = useState(metrics[0]?.label);
  const m = metrics.find((x) => x.label === active) ?? metrics[0];
  if (!m) return null;
  return (
    <div className="min-w-0">
      {metrics.length > 1 && (
        <div className="mb-3 overflow-x-auto [scrollbar-width:none]">
          <Segmented label="Measure" options={metrics.map((x) => x.label)} value={m.label} onChange={setActive} />
        </div>
      )}
      {m.series.length === 1 ? (
        <Trend
          points={m.data.map((r) => ({ date: String(r.date), value: r[m.series[0].key] as number | null }))}
          label={m.series[0].label}
          format={trendFormat(m)}
          position={m.format === "position"}
          misses={m.format === "position"}
          noun="check"
          height={height}
          table={height > 160}
        />
      ) : (
        <Lines metric={m} height={height} />
      )}
    </div>
  );
}
