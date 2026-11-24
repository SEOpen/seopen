"use client";

import { TimeChart } from "@/components/ui/time-chart";
import { Trend } from "@/components/ui/trend";
import { formatUsd } from "@/lib/format";

export type DailyPoint = { date: string; value: number };

const dollars = (v: number) => formatUsd(v, 2);
const dollarTick = (v: number) => `$${Number(v.toFixed(2))}`;

/**
 * One measure per day for Admin → Overview's small multiples. Counts go by the one chart rule, so a
 * sparse one sums into weeks or says it's too few to chart. Spend stays daily columns in cents: it isn't
 * a zigzag of whole numbers, and Trend's dollar format rounds to whole dollars. The title names the
 * measure, so there's no legend, and the page holds the table for all three.
 */
export function DailyColumns({ data, label, format = "number", height = 180 }: { data: DailyPoint[]; label: string; format?: "number" | "usd"; height?: number }) {
  if (!data.some((d) => d.value)) return <p className="text-sm text-secondary">None in these {data.length} days.</p>;
  if (format === "number") return <Trend points={data} label={label} counts noun="day" height={height} table={false} />;
  return <TimeChart data={data} series={[{ key: "value", label }]} label={label} form="columns" height={height} format={dollars} axisFormat={dollarTick} table={false} />;
}
