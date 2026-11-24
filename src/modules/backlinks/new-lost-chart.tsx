"use client";

import { useMemo, useState } from "react";
import { TimeChart } from "@/components/ui/time-chart";
import { formatNumber } from "@/lib/format";
import type { NewLostPoint } from "./logic";

type Kind = "domains" | "backlinks";

const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** The two charts' rows, and the one axis top they share. Lost counts arrive negative and are drawn upward here. */
export function newLostCharts(data: NewLostPoint[], kind: Kind) {
  const domains = kind === "domains";
  const noun = domains ? "domains" : "links";
  const rows = (read: (p: NewLostPoint) => number) => data.map((p) => ({ date: `${p.date}-01`, label: monthLabel(p.date), value: Math.abs(read(p)) }));
  const gained = rows((p) => (domains ? p.newDomains : p.newBacklinks));
  const lost = rows((p) => (domains ? p.lostDomains : p.lostBacklinks));
  return {
    charts: [
      { label: `New ${noun}`, color: "var(--chart-2)", rows: gained },
      { label: `Lost ${noun}`, color: "var(--bad)", rows: lost },
    ],
    yMax: Math.max(0, ...gained.map((r) => r.value), ...lost.map((r) => r.value)),
  };
}

/**
 * New and lost per month as small multiples: one axis top, so the two can be compared, and one crosshair,
 * so a month reads across both. Side by side when the column has room, stacked when it doesn't.
 * Each chart says in words which it is.
 */
export function NewLostChart({ data, kind, height = 180 }: { data: NewLostPoint[]; kind: Kind; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const { charts, yMax } = useMemo(() => newLostCharts(data, kind), [data, kind]);
  const total = (rows: { value: number }[]) => rows.reduce((n, r) => n + r.value, 0);
  return (
    <div className="@container min-w-0">
      <p className="sr-only">
        {kind === "domains" ? "Referring domains" : "Backlinks"}: {formatNumber(total(charts[0].rows))} new and {formatNumber(total(charts[1].rows))} lost across {data.length} months.
      </p>
      <div className="grid gap-x-6 gap-y-5 @lg:grid-cols-2">
        {charts.map((c) => (
          <div key={c.label} className="min-w-0">
            <h3 className="mb-2 text-sm font-medium">{c.label}</h3>
            <TimeChart data={c.rows} series={[{ key: "value", label: c.label, role: "entity", color: c.color }]} label={c.label} form="columns" height={height} yMax={yMax} hover={hover} onHover={setHover} />
          </div>
        ))}
      </div>
    </div>
  );
}
