"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { DataTableCore } from "@/components/ui/data-table";
import { Delta } from "@/components/ui/delta";
import { changeDelta } from "@/lib/brief";
import { formatNumber, formatPct } from "@/lib/format";

type Row = Record<string, unknown>;

/** The columns of a Search Console list. Serializable, so a server page can describe its table. */
export interface GscColumn {
  key: string;
  label: string;
  format?: "number" | "pct" | "position" | "link" | "url" | "count-change" | "position-change";
  /** For "link": href template with {field} placeholders. */
  href?: string;
  /** A row field whose text, when set, shows as a chip after the cell, such as "Likely a rank checker". */
  flag?: string;
}

const NUMERIC = new Set<GscColumn["format"]>(["number", "pct", "position", "count-change", "position-change"]);
const muted = <span className="text-muted">–</span>;

function fill(template: string, row: Row) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(row[k] ?? "")));
}

function cell(c: GscColumn, row: Row): ReactNode {
  const v = row[c.key];
  switch (c.format) {
    case "number":
      return formatNumber(v as number);
    case "pct":
      return formatPct(v as number);
    case "position":
      return v == null ? muted : String(v);
    case "link": {
      const link = <Link href={fill(c.href ?? "#", row)}>{String(v ?? "")}</Link>;
      const flag = c.flag ? row[c.flag] : null;
      if (!flag) return link;
      return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {link}
          <Badge>{String(flag)}</Badge>
        </span>
      );
    }
    case "url": {
      if (!v) return "–";
      const url = String(v);
      return (
        <a href={url} target="_blank" rel="noreferrer" title={url} className="block max-w-[28rem] truncate">
          {url.replace(/^https?:\/\//, "")}
        </a>
      );
    }
    case "count-change":
      return !v ? muted : <Delta {...changeDelta(v as number, "number", "up")} />;
    // The rows carry it as places gained, so a rise is better: "3.4 better", never a bare sign.
    case "position-change":
      return !v ? muted : <Delta {...changeDelta(-(v as number), "decimal", "down", true)} />;
    default:
      return v == null ? "–" : String(v);
  }
}

/** DataTable for Search Console's lists, whose position changes read as better or worse. */
export function GscTable({ columns, rows, filename, initialSort }: { columns: GscColumn[]; rows: Row[]; filename: string; initialSort?: { key: string; desc?: boolean } }) {
  const defs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((c) => ({
        id: c.key,
        accessorFn: (r) => r[c.key],
        header: c.label,
        sortUndefined: "last",
        cell: ({ row }) => cell(c, row.original),
        meta: { align: NUMERIC.has(c.format) ? "right" : "left" },
      })),
    [columns],
  );
  return <DataTableCore columns={defs} rows={rows} csvColumns={columns} filename={filename} initialSort={initialSort} />;
}
