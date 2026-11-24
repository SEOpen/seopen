import { SegmentedLinks } from "@/components/ui/segmented-links";
import { formatDay } from "@/lib/format";
import { resolvePeriods, type Compare, type Periods } from "../windowing";

export const RANGES = [7, 28, 90, 180, 365, 480] as const;
const COMPARES: { value: Compare; label: string }[] = [
  { value: "prev", label: "vs previous" },
  { value: "yoy", label: "vs last year" },
  { value: "none", label: "no compare" },
];

type SP = Record<string, string | string[] | undefined>;

export interface PeriodChoice {
  days: number;
  compare: Compare;
}

export function parsePeriod(sp: SP): PeriodChoice {
  const days = Number(sp.days);
  const compare = String(sp.compare ?? "prev") as Compare;
  return {
    days: (RANGES as readonly number[]).includes(days) ? days : 28,
    compare: COMPARES.some((c) => c.value === compare) ? compare : "prev",
  };
}

/** Periods ending at the newest stored date; the compare period is dropped if no data covers it. */
export function periodsFor(choice: PeriodChoice, data: { first: string; last: string }): Periods {
  const p = resolvePeriods(data.last, choice.days, choice.compare);
  if (p.previous && p.previous.end < data.first) return { ...p, previous: null };
  return p;
}

/** This page's URL with `patch` applied, keeping its other choices. */
export function hrefWith(path: string, sp: SP, patch: Record<string, string>) {
  const q = new URLSearchParams();
  // `run` spends on the pages that read it, and a range link must never repeat that.
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "run") q.set(k, v);
  for (const [k, v] of Object.entries(patch)) q.set(k, v);
  return `${path}?${q}`;
}

/** Range and compare switches as links, so the view is linkable and reloadable. */
export function PeriodControls({ path, sp, choice }: { path: string; sp: SP; choice: PeriodChoice }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SegmentedLinks label="Date range" options={RANGES.map((d) => ({ href: hrefWith(path, sp, { days: String(d) }), label: d === 480 ? "16m" : d === 365 ? "12m" : `${d}d`, active: choice.days === d }))} />
      <SegmentedLinks label="Compare with" options={COMPARES.map((c) => ({ href: hrefWith(path, sp, { compare: c.value }), label: c.label, active: choice.compare === c.value }))} />
    </div>
  );
}

export function describePeriods(p: Periods): string {
  const cur = `${formatDay(p.current.start)} – ${formatDay(p.current.end)}`;
  return p.previous ? `${cur}, compared with ${formatDay(p.previous.start)} – ${formatDay(p.previous.end)}` : cur;
}

/** What a chart's dashed line is. */
export function previousLabel(compare: Compare): string {
  return compare === "yoy" ? "Same days last year" : "Previous period";
}
