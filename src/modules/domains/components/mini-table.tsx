import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Compact, unsortable table for overview previews, with no box of its own. Server-only: cells are render
 * functions. A column with `isEmpty` hides when it's true for every row.
 */
export function MiniTable<T>({
  rows,
  columns,
  empty = "Nothing to show",
}: {
  rows: T[];
  columns: { label: string; render: (row: T) => ReactNode; align?: "right"; className?: string; isEmpty?: (row: T) => boolean }[];
  empty?: string;
}) {
  const shown = columns.filter((c) => !c.isEmpty || !rows.length || !rows.every(c.isEmpty));
  return (
    // Scrolls inside itself on a phone instead of widening the page.
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="table-head">
          <tr>
            {shown.map((c) => (
              <th key={c.label} className={cn("h-9 px-3 font-medium whitespace-nowrap first:pl-0 last:pr-0", c.align === "right" ? "text-right" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-line-soft">
              {shown.map((c) => (
                <td key={c.label} className={cn("px-3 py-2 first:pl-0 last:pr-0 [&_a]:underline-offset-4 [&_a:hover]:underline", c.align === "right" && "data text-right", c.className)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={shown.length} className="py-6 text-center text-muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
