import { ArrowRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { changeDelta, MIN_WEIGHT } from "@/lib/brief";
import { cn } from "@/lib/utils";
import { Delta, Digits } from "./delta";
import { describeChange, magnitude, shownChange, type AnyDashboardModule, type ChangeUnit, type KpiChange } from "./module-card";

const PER_GROUP = 3;
/** Relative changes in counts need this many on one side ("Impressions 10 → 6" is noise). */
const MIN_COUNT = 20;
/** A rate or average needs this many impressions or sessions behind it in both periods. */
const MIN_VOLUME = 100;

/** Whether a change rests on enough data to be worth a line. */
export function enoughData(c: Pick<KpiChange, "from" | "to" | "unit" | "volume">): boolean {
  if (c.unit === "percent" && Math.max(Math.abs(c.from), Math.abs(c.to)) < MIN_COUNT) return false;
  return c.volume == null || c.volume >= MIN_VOLUME;
}

export interface Highlight {
  key: string;
  module: string;
  href: string;
  /** What the change compares against, e.g. "previous 28 days". */
  baseline: string;
  label: string;
  /** Whether the arrow points up: the sign of the change, or "better" for a ranking position. */
  up: boolean;
  /** "up" or "down"; "improved" or "slipped" for a ranking position, where lower is better. */
  verb: string;
  /** Unsigned size in the change's unit: "100%", "5", "1.4 pts", "2.3 places". */
  amount: string;
  /** The signed change, as a number moved rather than better or worse: "+100%", "−2.3". */
  signed: string;
  /** The change for a dashboard row: `signed`, or "2.3 better" for a ranking position. */
  short: string;
  from: string;
  to: string;
  tone: "good" | "bad";
  weight: number;
}

/**
 * How big a change is, so different metrics can be ranked together: the move relative to the
 * starting value. Ratios ("points") start from at least 5%, so 0.1% → 0.2% CTR doesn't read as
 * +100%; counts and positions start from at least 1, and moves under 3 are scaled down so one
 * keyword entering the top 3 doesn't outrank a 40% traffic drop.
 */
export function changeWeight(c: Pick<KpiChange, "from" | "to" | "unit">): number {
  const delta = Math.abs(c.to - c.from);
  if (c.unit === "points") return delta / Math.max(Math.abs(c.from), 0.05);
  return (delta / Math.max(Math.abs(c.from), 1)) * Math.min(1, delta / 3);
}

/**
 * The biggest changes across every card with data, split into worse and better. `comparable` is
 * false when no card has anything earlier to compare against, so there's nothing to summarise.
 * `exclude` leaves out changes by key ("rank:Tracked position") that are already on the page.
 */
export function pickHighlights(entries: { module: AnyDashboardModule; data: unknown }[], exclude: ReadonlySet<string> = new Set()) {
  let comparable = false;
  const all: Highlight[] = [];
  for (const { module, data } of entries) {
    const baseline = module.baseline?.(data);
    const changes = (module.changes?.(data) ?? []).filter((c): c is KpiChange => c != null);
    if (!baseline || !changes.length) continue;
    comparable = true;
    for (const c of changes) {
      const { value, unit } = shownChange(c);
      const { text, tone } = describeChange(value, unit, c.goodWhen);
      const weight = changeWeight(c);
      if (tone === "muted" || weight < MIN_WEIGHT || !enoughData(c) || exclude.has(`${module.id}:${c.label}`)) continue;
      const amount = magnitude(Math.abs(value), unit);
      all.push({
        key: `${module.id}:${c.label}`,
        module: module.label,
        href: module.href,
        baseline,
        label: c.label,
        up: c.rank ? tone === "good" : value > 0,
        verb: c.rank ? (tone === "good" ? "improved" : "slipped") : value > 0 ? "up" : "down",
        amount: c.rank ? `${amount} place${amount === "1" ? "" : "s"}` : amount,
        signed: text,
        short: c.rank ? `${amount} ${tone === "good" ? "better" : "worse"}` : text,
        from: c.format(c.from),
        to: c.format(c.to),
        tone,
        weight,
      });
    }
  }
  all.sort((a, b) => b.weight - a.weight);
  return {
    comparable,
    worse: all.filter((h) => h.tone === "bad").slice(0, PER_GROUP),
    better: all.filter((h) => h.tone === "good").slice(0, PER_GROUP),
  };
}

/** A change on the dashboard: its size, whether that's better or worse, and which way the arrow points. */
export interface ChangeDelta {
  text: string;
  tone: "good" | "bad" | "muted";
  /** Null draws no arrow: no change, or nothing to show a direction for. */
  up: boolean | null;
}

/** The change between two readings as a delta, or null when either is missing. Pass `rank` for a position. */
export function deltaBetween(now: number | null | undefined, before: number | null | undefined, unit: ChangeUnit, goodWhen: "up" | "down" = "up", rank = false): ChangeDelta | null {
  return now == null || before == null ? null : changeDelta(now - before, unit, goodWhen, rank);
}

/** One line of "What changed": a value against its baseline, or the state the metric is in instead. */
export type ChangeRow = {
  key: string;
  label: string;
  /** The module the number comes from. */
  source: string;
  href: string;
  /** The period the value covers or what it compares against ("vs Oct 20"), when there is one. */
  meta?: string;
} & (
  | { state: "value"; from?: string; to: string; delta: ChangeDelta | null }
  /** Nothing to show: says why, and what opening the row does. */
  | { state: "empty"; text: string; action: string; tone?: "bad" }
);

/** How many rows the rail shows before folding the rest. */
const VISIBLE_ROWS = 5;

/** The standing rows then the biggest moves, cut at the rows the rail shows. Nothing is lost, only folded. */
export function foldRows<T>(rows: T[], also: T[] = []): { shown: T[]; folded: T[] } {
  const all = [...rows, ...also];
  return { shown: all.slice(0, VISIBLE_ROWS), folded: all.slice(VISIBLE_ROWS) };
}

/**
 * The rail beside a project's chart: what moved, in a fixed order, then anything else that moved.
 * Modules compare against different windows (a week of clicks, the nearest check about a week ago,
 * the previous run, the previous crawl), so every row says what it covers.
 */
export function WhatChanged({ rows, also = [], headingAs: Heading = "h2" }: { rows: ChangeRow[]; also?: ChangeRow[]; headingAs?: "h2" | "div" }) {
  const id = useId();
  const { shown, folded } = foldRows(rows, also);
  return (
    <section aria-labelledby={id}>
      <header className="flex items-baseline justify-between gap-4">
        <Heading id={id} className="text-[15px] font-medium">
          What changed
        </Heading>
        <p className="text-right text-xs text-muted">each against its own baseline</p>
      </header>
      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-secondary">Nothing to compare yet. Changes show here once a module has a second check.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line-soft">
          {shown.map((r) => (
            <Row key={r.key} row={r} />
          ))}
        </ul>
      )}
      {folded.length > 0 && (
        <details className="group border-t border-line-soft">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs font-medium text-accent hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
            <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            <span className="group-open:hidden">All {shown.length + folded.length}</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {folded.map((r) => (
              <Row key={r.key} row={r} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Where a row's number comes from and what it covers. The source goes when the label already says it. */
export function rowMeta(r: Pick<ChangeRow, "label" | "source" | "meta">): string {
  return [r.source === r.label ? null : r.source, r.meta].filter(Boolean).join(" · ");
}

function Row({ row: r }: { row: ChangeRow }) {
  const meta = rowMeta(r);
  return (
    <li>
      <Link
        href={r.href}
        className="-mx-2 block rounded-md px-2 py-2.5 transition-colors duration-[120ms] ease-instrument hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 text-sm">{r.label}</span>
          <RowEnd row={r} />
        </span>
        <span className="mt-1 block text-xs text-muted">
          {r.state === "value" ? (
            <span className="text-muted">
              {r.from && (
                <>
                  <Digits text={r.from} />
                  <span aria-hidden> → </span>
                  <span className="sr-only"> to </span>
                </>
              )}
              <span className="text-fg">
                <Digits text={r.to} />
              </span>
            </span>
          ) : (
            <span className={cn(r.tone === "bad" && "text-bad")}>{r.text}</span>
          )}
          {meta && <span aria-hidden> · </span>}
          {meta}
        </span>
      </Link>
    </li>
  );
}

/** The change, or where the row leads when there's nothing to compare. */
function RowEnd({ row: r }: { row: ChangeRow }) {
  if (r.state === "empty") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium whitespace-nowrap text-accent">
        {r.action}
        <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
      </span>
    );
  }
  if (!r.delta) return <span className="shrink-0 text-xs whitespace-nowrap text-muted">nothing earlier</span>;
  return <Delta {...r.delta} className="shrink-0" />;
}
