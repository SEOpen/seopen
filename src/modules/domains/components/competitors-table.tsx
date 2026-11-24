"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useState, useTransition } from "react";
import { addCompetitor } from "@/app/actions/projects";
import { ActionProblem } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { DataTableCore } from "@/components/ui/data-table";
import type { ActionRefusal } from "@/lib/action-result";
import { formatNumber, formatPct } from "@/lib/format";
import type { CompetitorRow } from "../transform";

const CSV_COLUMNS = [
  { key: "domain", label: "Domain" },
  { key: "overlap", label: "Overlap" },
  { key: "common", label: "Common keywords" },
  { key: "avgPosition", label: "Avg position" },
  { key: "keywords", label: "Keywords" },
  { key: "traffic", label: "Traffic" },
];

/** Competitor list with "add to project" and "open gap" actions. */
export function CompetitorsTable({
  rows,
  target,
  loc,
  project,
}: {
  rows: CompetitorRow[];
  target: string;
  loc: number;
  /** The current project and its competitors; null when there's no project. */
  project: { id: number; domain: string; competitors: string[] } | null;
}) {
  const [added, setAdded] = useState<Set<string>>(new Set(project?.competitors));
  const [pending, startTransition] = useTransition();
  const [refusal, setRefusal] = useState<ActionRefusal | null>(null);

  function add(domain: string) {
    if (!project) return;
    const fd = new FormData();
    fd.set("domain", domain);
    startTransition(async () => {
      const refused = await addCompetitor(project.id, fd);
      setRefusal(refused ?? null);
      if (!refused) setAdded((prev) => new Set(prev).add(domain));
    });
  }

  // Overlap needs this domain's own keyword count. Without it every row reads 0, so the column stays out.
  const hasOverlap = rows.length === 0 || rows.some((r) => r.overlap);

  const columns: ColumnDef<CompetitorRow>[] = [
    {
      id: "domain",
      accessorKey: "domain",
      header: "Domain",
      cell: ({ row }) => <Link href={`/domains?q=${encodeURIComponent(row.original.domain)}&loc=${loc}`}>{row.original.domain}</Link>,
    },
    ...(hasOverlap
      ? ([
          {
            id: "overlap",
            accessorKey: "overlap",
            header: "Overlap",
            cell: ({ row }) => (
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-20 rounded-sm bg-surface-2">
                  <span className="block h-full rounded-sm bg-secondary" style={{ width: `${row.original.overlap * 100}%` }} />
                </span>
                <span className="data w-9 text-right text-muted">{formatPct(row.original.overlap, 0)}</span>
              </span>
            ),
          },
        ] satisfies ColumnDef<CompetitorRow>[])
      : []),
    { id: "common", accessorKey: "common", header: "Common keywords", cell: ({ row }) => formatNumber(row.original.common), meta: { align: "right" } },
    { id: "avgPosition", accessorKey: "avgPosition", header: "Their average position", cell: ({ row }) => row.original.avgPosition, meta: { align: "right" } },
    { id: "keywords", accessorKey: "keywords", header: "Their keywords", cell: ({ row }) => formatNumber(row.original.keywords), meta: { align: "right" } },
    { id: "traffic", accessorKey: "traffic", header: "Their traffic", cell: ({ row }) => formatNumber(row.original.traffic), meta: { align: "right" } },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row }) => {
        const d = row.original.domain;
        return (
          <span className="flex justify-end gap-1.5 whitespace-nowrap">
            <Link href={`/domains/gap?q=${encodeURIComponent(target)}&vs=${encodeURIComponent(d)}&loc=${loc}`} className="rounded-sm px-2 py-1 text-xs hover:bg-surface-2">
              Keyword gap
            </Link>
            {project && project.domain === target && (
              <Button variant="secondary" size="sm" disabled={pending || added.has(d)} onClick={() => add(d)}>
                {added.has(d) ? "In project" : "Add to project"}
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ActionProblem result={refusal} />
      <DataTableCore columns={columns} rows={rows} filename={`${target}-competitors`} initialSort={{ key: "common", desc: true }} csvColumns={hasOverlap ? CSV_COLUMNS : CSV_COLUMNS.filter((c) => c.key !== "overlap")} />
    </div>
  );
}
