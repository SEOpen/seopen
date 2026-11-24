"use client";

import { useState } from "react";
import { Delta, Digits } from "@/components/ui/delta";
import { chartDay } from "@/components/ui/module-card";
import { Segmented } from "@/components/ui/segmented";
import { Trend } from "@/components/ui/trend";
import { countDelta } from "@/lib/brief";
import { formatNumber } from "@/lib/format";
import type { ClicksHistory } from "./dashboard-panel";

const RANGES = { "7d": 7, "28d": 28, "90d": 90 } as const;
type Range = keyof typeof RANGES;
const OPTIONS = Object.keys(RANGES) as Range[];

const sum = (days: ClicksHistory["days"]) => days.reduce((n, d) => n + d.clicks, 0);
const points = (days: ClicksHistory["days"]) => days.map((d) => ({ date: d.date, value: d.clicks }));

/** Clicks from Google over the period, against the same length before it. Stored data only, so changing the range costs nothing. */
export function ClicksPanel({ history, headingAs: Heading = "h2" }: { history: ClicksHistory; headingAs?: "h2" | "div" }) {
  const [range, setRange] = useState<Range>("28d");
  const n = RANGES[range];
  const current = history.days.slice(-n);
  const before = history.days.slice(-2 * n, -n);
  const total = sum(current);
  const change = before.length === n ? countDelta(total, sum(before)) : null;
  const last = current[current.length - 1];

  return (
    <section aria-labelledby="panel-clicks" className="flex min-w-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Heading id="panel-clicks" className="text-[15px] font-medium">
          Clicks from Google
        </Heading>
        <Segmented label="Chart range" options={OPTIONS} value={range} onChange={setRange} />
      </header>
      <p className="mt-1 mb-3 flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
        <span className="text-fg">
          <Digits text={`${formatNumber(total)} ${total === 1 ? "click" : "clicks"}`} />
        </span>
        <span>
          {current.length} day{current.length === 1 ? "" : "s"} to {last ? chartDay(last.date) : "–"}
        </span>
        {change && <Delta {...change} />}
        {change && <span>vs the {n} before</span>}
      </p>
      <Trend points={points(current)} previous={points(before)} label="Clicks" previousLabel={`Previous ${n} days`} counts noun="day" fill />
    </section>
  );
}
