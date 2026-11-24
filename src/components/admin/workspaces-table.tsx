"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo } from "react";
import { setWorkspaceSuspended } from "@/app/actions/billing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTableCore } from "@/components/ui/data-table";
import { formatNumber, formatUsd } from "@/lib/format";
import { rules } from "@/plan-policy/rules";

export interface WorkspaceRow extends Record<string, unknown> {
  id: number;
  name: string;
  /** "Nov 2", already in the workspace's time zone. */
  since: string;
  plan: string;
  subscriptionStatus: string | null;
  suspended: boolean;
  spentUsd: number;
  /** Null when the plan has no ceiling. */
  ceilingUsd: number | null;
  overAlert: boolean;
  last24Usd: number;
  credits: number;
  /** Null when the plan's credits are unlimited. */
  creditLimit: number | null;
  /** From the plan policy (`AdminWorkspaces`); null without one, and the column goes when every row is. */
  claims: number | null;
  note: string;
  /** The owner's workspace can't be suspended. */
  canSuspend: boolean;
}

function SuspendCell({ row: r }: { row: WorkspaceRow }) {
  if (!r.canSuspend) return null;
  return (
    <form action={setWorkspaceSuspended}>
      <input type="hidden" name="workspaceId" value={r.id} />
      <input type="hidden" name="suspended" value={r.suspended ? "0" : "1"} />
      {r.suspended ? (
        <Button type="submit" size="sm" variant="secondary" aria-label={`Restore ${r.name}`}>
          Restore
        </Button>
      ) : (
        <ConfirmSubmit variant="danger" question={`Suspend ${r.name}? Paid calls and jobs stop; data stays.`} confirmLabel="Suspend" aria-label={`Suspend ${r.name}`}>
          Suspend
        </ConfirmSubmit>
      )}
    </form>
  );
}

const COLUMNS: ColumnDef<WorkspaceRow>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: "Workspace",
    cell: ({ row: { original: r } }) => (
      <>
        <Link href={`/admin/workspaces/${r.id}`} className="font-medium">
          {r.name}
        </Link>
        <div className="text-xs text-muted">
          #{r.id} · since {r.since}
        </div>
      </>
    ),
  },
  {
    id: "plan",
    accessorKey: "plan",
    header: "Plan",
    cell: ({ row: { original: r } }) => (
      <>
        {r.plan}
        {r.subscriptionStatus && <span className="text-xs text-muted"> · {r.subscriptionStatus}</span>}
        {r.suspended && <span className="text-xs font-medium text-bad"> · suspended</span>}
      </>
    ),
  },
  {
    id: "spentUsd",
    accessorKey: "spentUsd",
    header: "Spent (month)",
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => (
      <span className={r.overAlert ? "font-medium" : undefined}>
        {r.overAlert && (
          <Badge tone="warn" className="mr-1.5 font-sans">
            Over alert
          </Badge>
        )}
        {formatUsd(r.spentUsd, 2)}
        {r.ceilingUsd != null && <span className="text-xs font-normal text-muted"> / {formatUsd(r.ceilingUsd, 2)}</span>}
      </span>
    ),
  },
  { id: "last24Usd", accessorKey: "last24Usd", header: "Last 24 h", meta: { align: "right" }, cell: ({ row: { original: r } }) => formatUsd(r.last24Usd, 2) },
  {
    id: "credits",
    accessorKey: "credits",
    // Without plans a credit is a cent, so the column is the dollars research lookups spent.
    header: rules.hasPlans ? "Credits" : "Research",
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => (
      <>
        {rules.hasPlans ? formatNumber(r.credits) : formatUsd(r.credits * rules.creditUsd, 2)}
        {r.creditLimit != null && <span className="text-xs text-muted"> / {formatNumber(r.creditLimit)}</span>}
      </>
    ),
  },
  { id: "claims", accessorKey: "claims", header: "Claims", meta: { align: "right" }, cell: ({ row: { original: r } }) => (r.claims == null ? "–" : formatNumber(r.claims)) },
  { id: "note", accessorKey: "note", header: "Notes", enableSorting: false, cell: ({ row: { original: r } }) => <span className="block max-w-64 min-w-40 text-xs text-muted">{r.note}</span> },
  {
    id: "actions",
    // relative: the sr-only label is positioned against this, so it can't widen the page on a phone.
    header: () => (
      <span className="relative block">
        <span className="sr-only">Actions</span>
      </span>
    ),
    enableSorting: false,
    enableGlobalFilter: false,
    meta: { align: "right" },
    cell: ({ row: { original: r } }) => <SuspendCell row={r} />,
  },
];

const CSV_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "name", label: "Workspace" },
  { key: "since", label: "Since" },
  { key: "plan", label: "Plan" },
  { key: "subscriptionStatus", label: "Subscription status" },
  { key: "suspended", label: "Suspended" },
  { key: "spentUsd", label: "Spent (month)" },
  { key: "ceilingUsd", label: "Ceiling" },
  { key: "overAlert", label: "Over alert" },
  { key: "last24Usd", label: "Last 24 h" },
  { key: "credits", label: rules.hasPlans ? "Credits" : "Research (cents)" },
  { key: "creditLimit", label: "Credit limit" },
  { key: "claims", label: "Claims" },
  { key: "note", label: "Notes" },
];

/** Every workspace with its Suspend or Restore button. Notes and claims go when no row has one. */
export function WorkspacesTable({ rows }: { rows: WorkspaceRow[] }) {
  const empty = useMemo(() => new Set([...(rows.some((r) => r.note) ? [] : ["note"]), ...(rows.some((r) => r.claims != null) ? [] : ["claims"])]), [rows]);
  const columns = useMemo(() => COLUMNS.filter((c) => !empty.has(c.id!)), [empty]);
  const csvColumns = useMemo(() => CSV_COLUMNS.filter((c) => c.key !== "claims" || !empty.has("claims")), [empty]);
  return <DataTableCore columns={columns} rows={rows} csvColumns={csvColumns} filename="workspaces" />;
}
