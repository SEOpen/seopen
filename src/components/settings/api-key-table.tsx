"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { revokeApiKeyAction } from "@/app/actions/api-keys";
import { useTimeZone } from "@/components/time-zone";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTableCore } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/format";

export type ApiKeyRow = {
  id: number;
  name: string;
  prefix: string;
  access: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

const CSV_COLUMNS = [
  { key: "name", label: "Name" },
  { key: "prefix", label: "Key starts with" },
  { key: "access", label: "Can" },
  { key: "createdAt", label: "Made" },
  { key: "lastUsedAt", label: "Last used" },
];

/**
 * Columns a phone's width leaves out, so the name isn't squeezed to a few letters a line. What a key
 * can do moves under its name there; its start and when it was made are in the CSV.
 */
const WIDE = { className: "hidden @2xl/main:table-cell" };

/** The workspace's working keys, each with Revoke, which asks in place. */
export function ApiKeyTable({ rows }: { rows: ApiKeyRow[] }) {
  const timeZone = useTimeZone();
  const columns = useMemo<ColumnDef<ApiKeyRow>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="min-w-32 break-words">
            <span className="font-medium">{row.original.name}</span>
            <span className="block text-xs text-muted @2xl/main:hidden">{row.original.access}</span>
          </div>
        ),
      },
      { id: "prefix", accessorKey: "prefix", header: "Key", enableSorting: false, meta: WIDE, cell: ({ row }) => <code className="font-mono text-xs whitespace-nowrap text-muted">{row.original.prefix}…</code> },
      { id: "access", accessorKey: "access", header: "Can", meta: WIDE, cell: ({ row }) => <span className="whitespace-nowrap">{row.original.access}</span> },
      { id: "createdAt", accessorFn: (r) => r.createdAt.getTime(), header: "Made", meta: WIDE, cell: ({ row }) => <span className="data whitespace-nowrap">{formatDateTime(row.original.createdAt, timeZone)}</span> },
      {
        id: "lastUsedAt",
        accessorFn: (r) => r.lastUsedAt?.getTime(),
        sortUndefined: "last",
        header: "Last used",
        // On a phone the date may break after its year, so the row fits beside the name.
        cell: ({ row }) => <span className="@2xl/main:whitespace-nowrap">{row.original.lastUsedAt ?<span className="data">{formatDateTime(row.original.lastUsedAt, timeZone)}</span> : "Never"}</span>,
      },
      {
        id: "revoke",
        enableSorting: false,
        header: () => <span className="sr-only">Revoke</span>,
        cell: ({ row: { original: k } }) => (
          <form action={revokeApiKeyAction} className="flex justify-end">
            <input type="hidden" name="id" value={k.id} />
            <ConfirmSubmit question={`Revoke ${k.name}? Agents using it stop working at once.`} confirmLabel="Revoke" variant="danger" aria-label={`Revoke ${k.name}`}>
              Revoke
            </ConfirmSubmit>
          </form>
        ),
      },
    ],
    [timeZone],
  );
  return <DataTableCore columns={columns} rows={rows} csvColumns={CSV_COLUMNS} filename="mcp-keys" />;
}
