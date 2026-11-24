"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { ActionProblem } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTableCore } from "@/components/ui/data-table";
import type { ActionRefusal } from "@/lib/action-result";
import { formatNumber } from "@/lib/format";
import { setDomainDecision } from "./actions";
import { columnsWithData, type ReviewLabel } from "./logic";

export interface ReviewTableRow extends Record<string, unknown> {
  domain: string;
  label: ReviewLabel;
  /** `label` in words, for the badge and the CSV. */
  labelText: string;
  score: number;
  reasons: string;
  spamScore: number | null;
  rank: number | null;
  backlinks: number;
  anchor: string | null;
  urlFrom: string | null;
  decision: "keep" | "disavow" | null;
}

const LABEL_TONE = { ok: "good", review: "warn", risky: "bad" } as const;

const OPTIONAL_COLUMNS = [{ key: "spamScore" }, { key: "rank" }, { key: "anchor" }];

function DecisionCell({ row, projectId }: { row: ReviewTableRow; projectId: number | null }) {
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<ActionRefusal | null>(null);
  if (!projectId) return <span className="text-xs text-muted">–</span>;
  const set = (decision: "keep" | "disavow" | "clear") =>
    start(async () => setProblem((await setDomainDecision({ projectId, domain: row.domain, decision, note: `${row.label} (${row.score}): ${row.reasons}`.slice(0, 500) })) ?? null));
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-1">
        {row.decision && (
          <Badge tone={row.decision === "disavow" ? "bad" : "good"} className="mr-1">
            {row.decision === "disavow" ? "Disavow" : "Keep"}
          </Badge>
        )}
        {row.decision !== "keep" && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => set("keep")}>
            Keep
          </Button>
        )}
        {row.decision !== "disavow" && (
          <Button size="sm" variant="danger" disabled={pending} onClick={() => set("disavow")}>
            Disavow
          </Button>
        )}
        {row.decision && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => set("clear")}>
            Undo
          </Button>
        )}
      </div>
      <ActionProblem result={problem} align="end" />
    </div>
  );
}

/** Link-review table with per-domain keep/disavow buttons (enabled only for the project's own domain). */
export function ReviewTable({ rows, projectId, filename, toolbar }: { rows: ReviewTableRow[]; projectId: number | null; filename: string; toolbar?: ReactNode }) {
  const columns = useMemo<ColumnDef<ReviewTableRow>[]>(
    () => [
      {
        id: "domain",
        accessorKey: "domain",
        header: "Domain",
        cell: ({ row }) => (
          <div className="max-w-[16rem]">
            <div className="truncate font-medium">{row.original.domain}</div>
            {row.original.urlFrom && (
              <a href={row.original.urlFrom} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs text-muted hover:text-accent" title={row.original.urlFrom}>
                {row.original.urlFrom.replace(/^https?:\/\//, "")}
              </a>
            )}
          </div>
        ),
      },
      {
        id: "score",
        accessorKey: "score",
        header: "Risk",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-2">
            <Badge tone={LABEL_TONE[row.original.label]}>{row.original.labelText}</Badge>
            <span className="data text-muted">{row.original.score}</span>
          </span>
        ),
      },
      {
        id: "reasons",
        accessorKey: "reasons",
        header: "Why",
        enableSorting: false,
        cell: ({ row }) => <span className="block max-w-[22rem] text-xs text-muted">{row.original.reasons || "No risk rules matched"}</span>,
      },
      { id: "spamScore", accessorKey: "spamScore", header: "Spam", meta: { align: "right" }, cell: ({ getValue }) => formatNumber(getValue() as number) },
      { id: "rank", accessorKey: "rank", header: "Domain strength", meta: { align: "right" }, cell: ({ getValue }) => formatNumber(getValue() as number) },
      { id: "backlinks", accessorKey: "backlinks", header: "Links", meta: { align: "right" }, cell: ({ getValue }) => formatNumber(getValue() as number) },
      {
        id: "anchor",
        accessorKey: "anchor",
        header: "Sample link text",
        enableSorting: false,
        cell: ({ getValue }) => <span className="block max-w-[14rem] truncate text-xs">{(getValue() as string) || "–"}</span>,
      },
      {
        id: "decision",
        accessorKey: "decision",
        header: "Decision",
        meta: { align: "right" },
        cell: ({ row }) => <DecisionCell row={row.original} projectId={projectId} />,
      },
    ],
    [projectId],
  );
  // Columns empty in every row go; so do decisions on a domain that isn't the project's, where none can be made.
  const visible = useMemo(() => {
    const kept = new Set(columnsWithData(OPTIONAL_COLUMNS, rows).map((c) => c.key));
    return columns.filter((c) => (c.id === "decision" ? projectId != null : !OPTIONAL_COLUMNS.some((o) => o.key === c.id) || kept.has(c.id ?? "")));
  }, [columns, rows, projectId]);
  return (
    <DataTableCore
      columns={visible}
      rows={rows}
      filename={filename}
      toolbar={toolbar}
      initialSort={{ key: "score", desc: true }}
      csvColumns={[
        { key: "domain", label: "Domain" },
        { key: "labelText", label: "Label" },
        { key: "score", label: "Score" },
        { key: "reasons", label: "Reasons" },
        { key: "spamScore", label: "Spam score" },
        { key: "rank", label: "Domain strength" },
        { key: "backlinks", label: "Links" },
        { key: "anchor", label: "Sample link text" },
        { key: "decision", label: "Decision" },
      ]}
    />
  );
}
