"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { DataTableCore } from "@/components/ui/data-table";
import { formatNumber } from "@/lib/format";
import type { CannibalRow } from "../pages";

const right = { align: "right" } as const;

const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "");

type Row = CannibalRow & Record<string, unknown>;

/** Keywords with more than one of your pages on them, the page Google showed last in full. */
export function CannibalTable({ rows }: { rows: CannibalRow[] }) {
  const columns = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "keyword",
        accessorKey: "keyword",
        header: "Keyword",
        cell: ({ row }) => (
          <Link href={`/rank/${row.original.keywordId}`} className="underline-offset-4 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {row.original.keyword}
          </Link>
        ),
      },
      {
        id: "urls",
        accessorFn: (r) => r.urls.join(" "),
        header: "Competing pages",
        enableSorting: false,
        cell: ({ row }) => (
          <ul className="space-y-0.5">
            {row.original.urls.map((u) => (
              <li key={u} className={u === row.original.latestUrl ? "font-medium" : "text-muted"}>
                <span className="inline-block max-w-[28rem] truncate align-bottom" title={u}>
                  {bare(u)}
                </span>
                {u === row.original.latestUrl && <span className="ml-1 text-xs font-normal text-muted">(latest)</span>}
              </li>
            ))}
          </ul>
        ),
      },
      { id: "flips", accessorKey: "flips", header: "Page swaps", meta: right },
      { id: "multiDays", accessorKey: "multiDays", header: "Checks with 2+ pages", cell: ({ row }) => `${row.original.multiDays} of ${row.original.checks}`, meta: right },
      { id: "bestPosition", accessorFn: (r) => r.bestPosition ?? 999, header: "Best position", cell: ({ row }) => row.original.bestPosition ?? "–", meta: right },
      { id: "volume", accessorFn: (r) => r.volume ?? -1, header: "Volume", cell: ({ row }) => formatNumber(row.original.volume), meta: right },
    ],
    [],
  );

  return (
    <DataTableCore
      columns={columns}
      rows={rows.map((r): Row => ({ ...r }))}
      filename="cannibal-keywords"
      initialSort={{ key: "volume", desc: true }}
      csvColumns={[
        { key: "keyword", label: "Keyword" },
        { key: "urls", label: "Competing pages" },
        { key: "latestUrl", label: "Latest page" },
        { key: "flips", label: "Page swaps" },
        { key: "multiDays", label: "Checks with 2+ pages" },
        { key: "checks", label: "Checks" },
        { key: "bestPosition", label: "Best position" },
        { key: "volume", label: "Volume" },
      ]}
    />
  );
}
