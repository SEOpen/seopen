"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DataTableCore } from "@/components/ui/data-table";
import { featureLabel, type SerpRow } from "../transform";

/** The link as text. For a result Google hid, the site plus Google's breadcrumb, since the URL is only the domain. */
export function shownUrl(r: Pick<SerpRow, "url" | "originOnly" | "breadcrumb">): string {
  const text = (r.url ?? "").replace(/^https?:\/\/(www\.)?/, "");
  return r.originOnly && r.breadcrumb ? `${text.replace(/\/$/, "")} › ${r.breadcrumb}` : text;
}

const COLUMNS: ColumnDef<SerpRow>[] = [
  {
    id: "position",
    // Features sit between the results but have no organic rank of their own.
    accessorFn: (r) => (r.type === "organic" ? r.position : undefined),
    header: "#",
    sortUndefined: "last",
    cell: ({ row: { original: r } }) => (r.type === "organic" ? r.position : ""),
    meta: { align: "right", width: 48 },
  },
  {
    id: "title",
    accessorFn: (r) => r.title ?? r.url ?? "",
    header: "Result",
    cell: ({ row: { original: r } }) => (
      <div className="flex max-w-[44rem] min-w-64 items-center gap-2">
        {r.type !== "organic" && <Badge tone="accent">{featureLabel(r.type)}</Badge>}
        {r.isProject && <Badge tone="good">Your site</Badge>}
        {r.url ? (
          <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 truncate" title={r.originOnly ? `${r.url} (Google hid the full link, so this goes to the site's home page)` : r.url}>
            <span className="font-medium">{r.title ?? r.url}</span>
            <span className="ml-2 font-mono text-xs text-muted">{shownUrl(r)}</span>
          </a>
        ) : (
          <span className="min-w-0 truncate text-muted">{r.title}</span>
        )}
        {r.originOnly && <Badge className="shrink-0">Domain only: Google hid the full link</Badge>}
      </div>
    ),
  },
  {
    id: "domain",
    accessorFn: (r) => r.domain ?? undefined,
    header: "Domain",
    sortUndefined: "last",
    cell: ({ row: { original: r } }) => (r.domain ? <Link href={`/domains?q=${encodeURIComponent(r.domain)}`}>{r.domain}</Link> : null),
  },
];

const CSV = [
  { key: "position", label: "Position" },
  { key: "type", label: "Type" },
  { key: "title", label: "Title" },
  { key: "url", label: "URL" },
  { key: "originOnly", label: "URL is domain only" },
  { key: "breadcrumb", label: "Breadcrumb" },
  { key: "domain", label: "Domain" },
];

/** The live top 10, in page order. Features keep their place between the results. */
export function SerpTable({ rows, filename }: { rows: SerpRow[]; filename: string }) {
  return <DataTableCore columns={COLUMNS} rows={rows} csvColumns={CSV} filename={filename} searchable={false} />;
}
