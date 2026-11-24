"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { disconnectAppAction } from "@/app/actions/connected-apps";
import { useTimeZone } from "@/components/time-zone";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTableCore } from "@/components/ui/data-table";
import { formatDateTime } from "@/lib/format";

export type ConnectedAppRow = {
  id: string;
  name: string;
  /** Who connected it. */
  person: string;
  access: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

const CSV_COLUMNS = [
  { key: "name", label: "App" },
  { key: "person", label: "Connected by" },
  { key: "access", label: "Can" },
  { key: "createdAt", label: "Connected" },
  { key: "lastUsedAt", label: "Last used" },
];

/** Apps connected to the workspace over OAuth, each with Disconnect, which asks in place, as a key's Revoke does. */
export function ConnectedAppTable({ rows }: { rows: ConnectedAppRow[] }) {
  const timeZone = useTimeZone();
  const columns = useMemo<ColumnDef<ConnectedAppRow>[]>(
    () => [
      { id: "name", accessorKey: "name", header: "App", cell: ({ row }) => <span className="font-medium [overflow-wrap:anywhere]">{row.original.name}</span> },
      { id: "person", accessorKey: "person", header: "Connected by", cell: ({ row }) => <span className="[overflow-wrap:anywhere]">{row.original.person}</span> },
      { id: "access", accessorKey: "access", header: "Can", cell: ({ row }) => <span className="whitespace-nowrap">{row.original.access}</span> },
      { id: "createdAt", accessorFn: (r) => r.createdAt.getTime(), header: "Connected", cell: ({ row }) => <span className="data whitespace-nowrap">{formatDateTime(row.original.createdAt, timeZone)}</span> },
      {
        id: "lastUsedAt",
        accessorFn: (r) => r.lastUsedAt?.getTime(),
        sortUndefined: "last",
        header: "Last used",
        cell: ({ row }) => <span className="whitespace-nowrap">{row.original.lastUsedAt ? <span className="data">{formatDateTime(row.original.lastUsedAt, timeZone)}</span> : "Never"}</span>,
      },
      {
        id: "disconnect",
        enableSorting: false,
        header: () => <span className="sr-only">Disconnect</span>,
        cell: ({ row: { original: a } }) => (
          <form action={disconnectAppAction} className="flex justify-end">
            <input type="hidden" name="id" value={a.id} />
            <ConfirmSubmit question={`Disconnect ${a.name}? It stops working at once.`} confirmLabel="Disconnect" variant="danger" aria-label={`Disconnect ${a.name}`}>
              Disconnect
            </ConfirmSubmit>
          </form>
        ),
      },
    ],
    [timeZone],
  );
  return <DataTableCore columns={columns} rows={rows} csvColumns={CSV_COLUMNS} filename="mcp-connected-apps" />;
}
