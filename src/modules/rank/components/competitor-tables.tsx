"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { addCompetitor } from "@/app/actions/projects";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { DataTableCore } from "@/components/ui/data-table";
import { Delta } from "@/components/ui/delta";
import { formatNumber, formatPct } from "@/lib/format";
import type { CompetitorRow } from "../brief";

const right = { align: "right" } as const;

function Change({ delta }: { delta: CompetitorRow["shareDelta"] }) {
  return delta && delta.tone !== "muted" ? <Delta {...delta} /> : <span className="text-muted">–</span>;
}

/** You and the competitors you follow. A column with nothing in it, such as change on a single check, isn't drawn. */
export function TrackedDomainsTable({ rows }: { rows: CompetitorRow[] }) {
  const columns = useMemo<ColumnDef<CompetitorRow>[]>(() => {
    const all: ColumnDef<CompetitorRow>[] = [
      { id: "label", accessorKey: "label", header: "Domain", cell: ({ row }) => <span className={row.original.isYou ? "font-medium" : undefined}>{row.original.label}</span> },
      { id: "shareOfVoice", accessorFn: (r) => r.shareOfVoice ?? 0, header: "Share of voice", cell: ({ row }) => formatPct(row.original.shareOfVoice, 2), meta: right },
      { id: "shareChange", accessorFn: (r) => r.shareChange ?? 0, header: "Change", cell: ({ row }) => <Change delta={row.original.shareDelta} />, meta: right },
      { id: "visibility", accessorFn: (r) => r.visibility ?? 0, header: "Visibility", cell: ({ row }) => formatPct(row.original.visibility), meta: right },
      { id: "visibilityChange", accessorFn: (r) => r.visibilityChange ?? 0, header: "Change", cell: ({ row }) => <Change delta={row.original.visibilityDelta} />, meta: right },
      { id: "traffic", accessorKey: "traffic", header: "Est. traffic", cell: ({ row }) => formatNumber(row.original.traffic), meta: right },
      { id: "avgPosition", accessorFn: (r) => r.avgPosition ?? 999, header: "Tracked position", cell: ({ row }) => (row.original.avgPosition != null ? row.original.avgPosition.toFixed(1) : "–"), meta: right },
      { id: "top3", accessorKey: "top3", header: "Top 3", meta: right },
      { id: "top10", accessorKey: "top10", header: "Top 10", meta: right },
      { id: "ranking", accessorFn: (r) => r.top100, header: "Ranking", cell: ({ row }) => row.original.ranking, meta: right },
    ];
    const hide = new Set<string>();
    if (rows.every((r) => r.shareChange == null)) hide.add("shareChange");
    if (rows.every((r) => r.visibilityChange == null)) hide.add("visibilityChange");
    if (rows.every((r) => !r.traffic)) hide.add("traffic");
    return all.filter((c) => !hide.has(c.id ?? ""));
  }, [rows]);

  return (
    <DataTableCore
      columns={columns}
      rows={rows}
      filename="rank-competitors"
      searchable={false}
      initialSort={{ key: "shareOfVoice", desc: true }}
      csvColumns={[
        { key: "domain", label: "Domain" },
        { key: "shareOfVoice", label: "Share of voice" },
        { key: "shareChange", label: "Share of voice change" },
        { key: "visibility", label: "Visibility" },
        { key: "visibilityChange", label: "Visibility change" },
        { key: "traffic", label: "Est. traffic" },
        { key: "avgPosition", label: "Tracked position" },
        { key: "top3", label: "Top 3" },
        { key: "top10", label: "Top 10" },
        { key: "ranking", label: "Ranking" },
      ]}
    />
  );
}

export interface DiscoveredRow extends Record<string, unknown> {
  domain: string;
  keywords: number;
  avgPosition: number;
  visibility: number;
  shareOfVoice: number;
}

/** Every other domain on the latest results, each one a click from being followed. */
export function DiscoveredDomainsTable({ rows, projectId }: { rows: DiscoveredRow[]; projectId: number }) {
  const columns = useMemo<ColumnDef<DiscoveredRow>[]>(
    () => [
      { id: "domain", accessorKey: "domain", header: "Domain" },
      { id: "shareOfVoice", accessorKey: "shareOfVoice", header: "Share of voice", cell: ({ row }) => formatPct(row.original.shareOfVoice, 2), meta: right },
      { id: "visibility", accessorKey: "visibility", header: "Visibility", cell: ({ row }) => formatPct(row.original.visibility), meta: right },
      { id: "keywords", accessorKey: "keywords", header: "Keywords", meta: right },
      { id: "avgPosition", accessorKey: "avgPosition", header: "Tracked position", cell: ({ row }) => row.original.avgPosition.toFixed(1), meta: right },
      {
        id: "add",
        enableSorting: false,
        enableGlobalFilter: false,
        header: () => <span className="sr-only">Add</span>,
        cell: ({ row }) => (
          <ActionForm action={addCompetitor.bind(null, projectId)} align="end">
            <input type="hidden" name="domain" value={row.original.domain} />
            <Button size="sm" variant="ghost" type="submit">
              Add as competitor
            </Button>
          </ActionForm>
        ),
      },
    ],
    [projectId],
  );

  return (
    <DataTableCore
      columns={columns}
      rows={rows}
      filename="rank-other-domains"
      initialSort={{ key: "shareOfVoice", desc: true }}
      csvColumns={[
        { key: "domain", label: "Domain" },
        { key: "shareOfVoice", label: "Share of voice" },
        { key: "visibility", label: "Visibility" },
        { key: "keywords", label: "Keywords" },
        { key: "avgPosition", label: "Tracked position" },
      ]}
    />
  );
}
