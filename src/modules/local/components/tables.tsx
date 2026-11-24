"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { useTimeZone } from "@/components/time-zone";
import { DataTableCore } from "@/components/ui/data-table";
import { Delta } from "@/components/ui/delta";
import type { ChangeDelta } from "@/components/ui/what-changed";
import { formatDateTime, formatPct, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const NONE = <span className="text-muted">–</span>;

/** A column read from one field of the row, sorted on that field, with a custom cell. */
function column<T>(key: keyof T & string, header: string, cell: (row: T) => ReactNode, right = false): ColumnDef<T> {
  return {
    id: key,
    accessorFn: (r) => r[key] ?? undefined,
    header,
    sortUndefined: "last",
    cell: ({ row }) => cell(row.original),
    meta: { align: right ? "right" : "left" },
  };
}

const rankCell = (avgRank: number | null) => (avgRank == null ? NONE : avgRank.toFixed(1));
const changeCell = (delta: ChangeDelta | null) => (delta ? <Delta {...delta} /> : NONE);

export type BusinessRow = {
  id: number;
  title: string;
  address: string | null;
  grid: string;
  keywords: number;
  avgRank: number | null;
  /** Change in average rank, negative is better: the sort key and the CSV value. */
  change: number | null;
  delta: ChangeDelta | null;
  top3: number | null;
  found: string;
  lastChecked: string | null;
  /** What became of the newest check, when it didn't work: "failed Nov 7", "didn't start Nov 7". `lastChecked` is then older than that. */
  lastTry?: string | null;
};

/** Every business in the project, with its latest check. */
export function BusinessesTable({ rows }: { rows: BusinessRow[] }) {
  const timeZone = useTimeZone();
  const hasChange = rows.some((r) => r.change != null);
  const columns = useMemo<ColumnDef<BusinessRow>[]>(
    () => [
      column<BusinessRow>("title", "Business", (r) => (
        <span className="block max-w-[28rem] min-w-40">
          <Link href={`/local/${r.id}`} className="block truncate font-medium">
            {r.title}
          </Link>
          {r.address && <span className="block truncate text-xs text-muted">{r.address}</span>}
        </span>
      )),
      column<BusinessRow>("grid", "Grid", (r) => <span className="whitespace-nowrap text-muted">{r.grid}</span>),
      column<BusinessRow>("keywords", "Keywords", (r) => String(r.keywords), true),
      column<BusinessRow>("avgRank", "Avg. rank", (r) => rankCell(r.avgRank), true),
      ...(hasChange ? [column<BusinessRow>("change", "Change", (r) => changeCell(r.delta), true)] : []),
      column<BusinessRow>("top3", "Top 3", (r) => (r.top3 == null ? NONE : formatPct(r.top3, 0)), true),
      column<BusinessRow>("found", "Found", (r) => r.found, true),
      column<BusinessRow>("lastChecked", "Last check", (r) => (
        <>
          {r.lastChecked ? <span className="data">{formatDateTime(r.lastChecked, timeZone)}</span> : !r.lastTry && "Not yet"}
          {r.lastTry && <span className={cn("block text-xs", r.lastTry.startsWith("failed") ? "text-bad" : "text-muted")}>{r.lastChecked ? "newer check " : ""}{r.lastTry}</span>}
        </>
      ), true),
    ],
    [hasChange, timeZone],
  );
  return (
    <DataTableCore
      rows={rows}
      columns={columns}
      filename="local-businesses"
      csvColumns={[
        { key: "title", label: "Business" },
        { key: "address", label: "Address" },
        { key: "grid", label: "Grid" },
        { key: "keywords", label: "Keywords" },
        { key: "avgRank", label: "Avg. rank" },
        ...(hasChange ? [{ key: "change", label: "Change" }] : []),
        { key: "top3", label: "Top 3" },
        { key: "found", label: "Found" },
        { key: "lastChecked", label: "Last check" },
      ]}
    />
  );
}

export type KeywordRow = {
  id: number;
  businessId: number;
  keyword: string;
  avgRank: number | null;
  top3: number | null;
  found: string;
  /** Change in average rank, negative is better: the sort key and the CSV value. */
  change: number | null;
  delta: ChangeDelta | null;
  lastChecked: string | null;
};

/** One row per keyword, from the check on screen, against that keyword's previous check. */
export function KeywordsTable({ rows, businessId, current }: { rows: KeywordRow[]; businessId: number; current?: number }) {
  const timeZone = useTimeZone();
  const hasChange = rows.some((r) => r.change != null);
  const columns = useMemo<ColumnDef<KeywordRow>[]>(
    () => [
      column<KeywordRow>("keyword", "Keyword", (r) => (
        <span className="inline-flex items-baseline gap-2">
          <Link href={`/local/${r.businessId}?k=${r.id}`} aria-current={r.id === current ? "true" : undefined}>
            {r.keyword}
          </Link>
          {r.id === current && <span className="text-xs whitespace-nowrap text-muted">on the map</span>}
        </span>
      )),
      column<KeywordRow>("avgRank", "Avg. rank", (r) => rankCell(r.avgRank), true),
      column<KeywordRow>("top3", "Top 3", (r) => (r.top3 == null ? NONE : formatPct(r.top3)), true),
      column<KeywordRow>("found", "Found", (r) => r.found, true),
      ...(hasChange ? [column<KeywordRow>("change", "Change", (r) => changeCell(r.delta), true)] : []),
      column<KeywordRow>("lastChecked", "Last checked", (r) => (r.lastChecked ? <span className="data">{formatDateTime(r.lastChecked, timeZone)}</span> : NONE), true),
    ],
    [current, hasChange, timeZone],
  );
  return (
    <DataTableCore
      rows={rows}
      columns={columns}
      filename={`local-${businessId}-keywords`}
      initialSort={{ key: "keyword", desc: false }}
      csvColumns={[
        { key: "keyword", label: "Keyword" },
        { key: "avgRank", label: "Avg. rank" },
        { key: "top3", label: "Top 3" },
        { key: "found", label: "Found" },
        ...(hasChange ? [{ key: "change", label: "Change" }] : []),
        { key: "lastChecked", label: "Last checked" },
      ]}
    />
  );
}

export type HistoryRow = {
  id: number;
  /** When it ran, the sort key. */
  at: string;
  /** When it ran, in the workspace's zone. */
  when: string;
  /** Where to show it on the map; null for a check with no results to show. */
  href: string | null;
  current: boolean;
  /** "scheduled", "manual", and whether it failed or is still running. */
  note: string;
  grid: string;
  avgRank: number | null;
  top3: number | null;
  found: string;
  /** Left out of the row entirely unless the workspace sees dollars. */
  costUsd?: number | null;
};

/** Every check of a business, newest first. Pick one to show it on the map. */
export function HistoryTable({ rows, businessId, showUsd }: { rows: HistoryRow[]; businessId: number; showUsd: boolean }) {
  const columns = useMemo<ColumnDef<HistoryRow>[]>(
    () => [
      column<HistoryRow>("at", "Checked", (r) => (
        <span className="flex flex-wrap items-baseline gap-x-2">
          {r.href ? (
            <Link href={r.href} aria-current={r.current ? "true" : undefined} className="whitespace-nowrap">
              {r.when}
            </Link>
          ) : (
            <span className="whitespace-nowrap">{r.when}</span>
          )}
          <span className="text-xs text-muted">
            {r.note}
            {r.current ? " · on the map" : ""}
          </span>
        </span>
      )),
      column<HistoryRow>("grid", "Grid", (r) => <span className="whitespace-nowrap text-muted">{r.grid}</span>),
      column<HistoryRow>("avgRank", "Avg. rank", (r) => rankCell(r.avgRank), true),
      column<HistoryRow>("top3", "Top 3", (r) => (r.top3 == null ? NONE : formatPct(r.top3, 0)), true),
      column<HistoryRow>("found", "Found", (r) => r.found, true),
      ...(showUsd ? [column<HistoryRow>("costUsd", "Cost", (r) => <span className="text-muted">{formatUsd(r.costUsd, 3)}</span>, true)] : []),
    ],
    [showUsd],
  );
  return (
    <DataTableCore
      rows={rows}
      columns={columns}
      filename={`local-${businessId}-history`}
      searchable={false}
      pageSize={10}
      csvColumns={[
        { key: "when", label: "Checked" },
        { key: "note", label: "Kind" },
        { key: "grid", label: "Grid" },
        { key: "avgRank", label: "Avg. rank" },
        { key: "top3", label: "Top 3" },
        { key: "found", label: "Found" },
        ...(showUsd ? [{ key: "costUsd", label: "Cost" }] : []),
      ]}
    />
  );
}
