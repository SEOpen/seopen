"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useTimeZone } from "@/components/time-zone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Delta, Digits } from "@/components/ui/delta";
import { Input } from "@/components/ui/input";
import { csvCell } from "@/lib/csv";
import { formatDate, formatDateTime, formatNumber, formatPct, formatTimestamp, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Row = Record<string, unknown>;

/**
 * Serializable column spec, so Server Components can pass columns to the table.
 * For cells that need custom React, use <DataTableCore> from a client component instead.
 */
export interface ColumnSpec {
  key: string;
  label: string;
  format?: "text" | "number" | "usd" | "pct" | "date" | "datetime" | "position" | "url" | "link" | "badge" | "delta";
  /** For format "link": href template with {field} placeholders, e.g. "/keywords?q={keyword}". */
  href?: string;
  /** For format "url": a field holding the text to show in place of the address, when the address says nothing. */
  labelKey?: string;
  /** For format "delta": "down" when a negative change is good (rank positions). */
  goodWhen?: "up" | "down";
  align?: "left" | "right";
  width?: number;
  /** Defaults to true. */
  sortable?: boolean;
  /** A preformatted date or number in a text column: sets it as data. */
  data?: boolean;
}

function fillTemplate(template: string, row: Row) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(row[k] ?? "")));
}

function renderCell(spec: ColumnSpec, row: Row, timeZone: string): ReactNode {
  const v = row[spec.key];
  switch (spec.format) {
    case "number":
      return <span className="data">{formatNumber(v as number)}</span>;
    case "usd":
      return <span className="data">{formatUsd(v as number)}</span>;
    case "pct":
      return <span className="data">{formatPct(v as number)}</span>;
    case "date":
      return <span className="data">{formatDate(v as string, timeZone)}</span>;
    case "datetime":
      return <span className="data">{formatDateTime(v as string, timeZone)}</span>;
    case "position":
      return v == null ? <span className="text-muted">–</span> : <span className="data">{String(v)}</span>;
    case "url": {
      if (!v) return "–";
      const s = String(v);
      const label = spec.labelKey ? row[spec.labelKey] : null;
      // A label is words, not an address, so it reads as a link rather than data.
      return (
        <a href={s} target="_blank" rel="noreferrer" className={cn("block max-w-[28rem] truncate hover:underline", label ? "text-accent" : "data text-secondary")} title={s}>
          {label ? String(label) : s.replace(/^https?:\/\//, "")}
        </a>
      );
    }
    case "link":
      return (
        <Link href={fillTemplate(spec.href ?? "#", row)} className="text-accent hover:underline">
          {String(v ?? "")}
        </Link>
      );
    case "badge":
      return v ? <Badge>{String(v)}</Badge> : "–";
    case "delta": {
      const n = Number(v);
      if (v == null || Number.isNaN(n) || n === 0) return <span className="text-muted">–</span>;
      const good = spec.goodWhen === "down" ? n < 0 : n > 0;
      return <Delta text={`${n > 0 ? "+" : "−"}${Math.abs(n)}`} tone={good ? "good" : "bad"} />;
    }
    default:
      if (v == null) return "–";
      return isCount(v) ? <Digits text={String(v)} digitClassName="data" /> : String(v);
  }
}

const COUNT_NUMBER = String.raw`[+−-]?[$€£]?\d+(?:[.,]\d+)*%?`;
/** The whole value: "12", "$1,204", "5 of 9", "5/9", "12 of 30 (2 failed), 3 rechecked", "5/9 · 2 failed". */
const COUNT = new RegExp(`^${COUNT_NUMBER}(?:(?: of |/)${COUNT_NUMBER})?(?:(?: \\(|, | · )\\d[\\d.,]* [a-z ]+\\)?)*$`);

/** Whether a cell's value is a count, whose digits take the data size. Free text with a number in it stays plain: "Top 10 SEO tools", "3d printers". */
export function isCount(value: unknown): boolean {
  return typeof value === "number" || (typeof value === "string" && COUNT.test(value));
}

/** Whether a cell's value is words, which a right-aligned column shouldn't set as data. */
export function isWordy(value: unknown): boolean {
  return typeof value === "string" && /\p{L}/u.test(value);
}

/** Text goes through `csvCell`, so a crawled page title starting with `=` downloads as text, not a formula. */
export function toCsv(rows: Row[], columns: { key: string; label: string }[], timeZone: string) {
  const esc = (v: unknown) => csvCell(v instanceof Date ? formatTimestamp(v, timeZone) : v);
  return [columns.map((c) => esc(c.label)).join(","), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(","))].join("\n");
}

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** A shorter table is read at a glance, so it gets no filter box. */
const FILTER_FROM = 8;

const NUMERIC = new Set(["number", "usd", "pct", "position", "delta"]);

export function DataTable({
  columns,
  rows,
  filename = "export",
  searchable = true,
  pageSize = 50,
  initialSort,
  toolbar,
}: {
  columns: ColumnSpec[];
  rows: Row[];
  /** CSV filename without extension. */
  filename?: string;
  searchable?: boolean;
  pageSize?: number;
  initialSort?: { key: string; desc?: boolean };
  toolbar?: ReactNode;
}) {
  const timeZone = useTimeZone();
  const defs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((c) => ({
        id: c.key,
        // TanStack sorts only `undefined` last; a null would sort as the smallest value.
        accessorFn: (r) => r[c.key] ?? undefined,
        header: c.label,
        enableSorting: c.sortable !== false,
        sortUndefined: "last",
        cell: ({ row }) => renderCell(c, row.original, timeZone),
        meta: { align: c.align ?? (NUMERIC.has(c.format ?? "") ? "right" : "left"), width: c.width, className: c.data ? "data" : undefined },
      })),
    [columns, timeZone],
  );
  return (
    <DataTableCore
      columns={defs}
      rows={rows}
      csvColumns={columns}
      filename={filename}
      searchable={searchable}
      pageSize={pageSize}
      initialSort={initialSort}
      toolbar={toolbar}
    />
  );
}

/** Table with sorting, search, paging and CSV export, for client components that need custom cells. */
export function DataTableCore<T extends Row>({
  columns,
  rows,
  csvColumns,
  filename = "export",
  searchable = true,
  pageSize = 50,
  initialSort,
  toolbar,
}: {
  columns: ColumnDef<T>[];
  rows: T[];
  csvColumns: { key: string; label: string }[];
  filename?: string;
  searchable?: boolean;
  pageSize?: number;
  initialSort?: { key: string; desc?: boolean };
  toolbar?: ReactNode;
}) {
  const timeZone = useTimeZone();
  const [sorting, setSorting] = useState<SortingState>(initialSort ? [{ id: initialSort.key, desc: !!initialSort.desc }] : []);
  const [filter, setFilter] = useState("");
  // TanStack Table returns unstable functions; React Compiler skips memoizing this component, which is fine.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });
  const filtered = table.getFilteredRowModel().rows;
  const { pageIndex } = table.getState().pagination;

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
        {searchable && rows.length > FILTER_FROM && (
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rows…" className="h-8 w-64" />
        )}
        {toolbar}
        <span className="ml-auto text-xs text-muted">
          <Digits text={`${formatNumber(filtered.length)} ${filtered.length === 1 ? "row" : "rows"}`} />
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="h-8"
          onClick={() => download(`${filename}.csv`, toCsv(filtered.map((r) => r.original), csvColumns, timeZone))}
          disabled={!filtered.length}
        >
          Export CSV
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="table-head">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta as { align?: string; width?: number; className?: string } | undefined;
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      style={meta?.width ? { width: meta.width } : undefined}
                      className={cn("h-9 px-3 font-medium whitespace-nowrap", meta?.align === "right" ? "text-right" : "text-left", meta?.className)}
                    >
                      {h.column.getCanSort() ? (
                        <button type="button" onClick={h.column.getToggleSortingHandler()} className="relative inline-flex items-center rounded-sm hover:text-fg focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {/* Out of the flow, in the cell's padding: the label stays on the column's edge and sorting moves nothing. */}
                          {sorted && (
                            <span aria-hidden className={cn("absolute top-1/2 -translate-y-1/2", meta?.align === "right" ? "right-full" : "left-full")}>
                              {sorted === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                            </span>
                          )}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr key={r.id} className="border-t border-line-soft hover:bg-surface-2/60">
                {r.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as { align?: string; className?: string } | undefined;
                  const right = meta?.align === "right";
                  return (
                    <td key={cell.id} className={cn("px-3 py-2.5 [&_a]:text-fg [&_a]:no-underline [&_a]:underline-offset-4 [&_a:hover]:underline", right && "text-right", right && !isWordy(cell.getValue()) && "data", meta?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-muted">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-3 py-2 text-xs text-muted">
          <span>
            Page {pageIndex + 1} of {table.getPageCount()}
          </span>
          <Button variant="secondary" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            Previous
          </Button>
          <Button variant="secondary" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
