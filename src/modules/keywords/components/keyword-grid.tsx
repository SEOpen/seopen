"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { createContext, useContext, useMemo, useState, useTransition, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTableCore } from "@/components/ui/data-table";
import { Delta } from "@/components/ui/delta";
import { Input, Select } from "@/components/ui/input";
import { useTimeZone } from "@/components/time-zone";
import { formatDate, formatNumber, formatPct, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { addToList, removeFromList } from "../actions";
import { intentTone, kdClass, kdLabel } from "../format";
import type { Market } from "../requests";

type Row = Record<string, unknown> & { keyword: string };

/** Serializable column spec, so Server Components can configure the grid. */
export interface GridColumn {
  key: string;
  label: string;
  format?: "text" | "keyword" | "number" | "usd" | "pct" | "kd" | "intent" | "position" | "change" | "url" | "domain" | "status" | "feature" | "date";
  align?: "left" | "right";
}

const NUMERIC = new Set(["number", "usd", "pct", "kd", "position", "change"]);

const STATUS_TONE = { new: "accent", improved: "good", declined: "bad", lost: "bad", same: "neutral" } as const;

/**
 * A keyword's research page, in the market it came from: a saved keyword's own `locationCode`, else
 * the grid's market. Without `loc` the page would look it up in the project's own market.
 */
export function keywordHref(keyword: string, locationCode?: unknown): string {
  return `/keywords?${new URLSearchParams({ q: keyword, ...(Number.isInteger(locationCode) ? { loc: String(locationCode) } : {}) })}`;
}

function cell(col: GridColumn, row: Row, timeZone: string, market?: Market): ReactNode {
  const v = row[col.key];
  const muted = <span className="text-muted">–</span>;
  switch (col.format) {
    case "keyword":
      return (
        <Link href={keywordHref(String(v), row.locationCode ?? market?.locationCode)} className="inline-block min-w-44 text-accent hover:underline">
          {String(v)}
        </Link>
      );
    case "number":
      return v == null ? muted : formatNumber(v as number);
    case "usd":
      return v == null ? muted : formatUsd(v as number);
    case "pct":
      return v == null ? muted : formatPct(v as number);
    case "kd":
      // The word carries the colour, so the numbers stay in line and the colour is never alone.
      return v == null ? (
        muted
      ) : (
        <span className="inline-flex items-baseline justify-end gap-1.5 whitespace-nowrap">
          <span className={cn("font-sans text-xs", kdClass(v as number))}>{kdLabel(v as number)}</span>
          {Math.round(v as number)}
        </span>
      );
    case "date":
      return v == null ? muted : <span className="data">{formatDate(v as string, timeZone)}</span>;
    case "intent":
      return v ? <Badge tone={intentTone(v as string)}>{String(v)}</Badge> : muted;
    case "position":
      return v == null ? muted : String(v);
    case "change": {
      const n = v as number | null;
      if (n == null || n === 0) return muted;
      return <Delta text={formatNumber(Math.abs(n))} tone={n > 0 ? "good" : "bad"} up={n > 0} />;
    }
    case "url": {
      if (!v) return muted;
      const s = String(v);
      return (
        <a href={s} target="_blank" rel="noreferrer" className="data block max-w-[22rem] truncate text-accent hover:underline" title={s}>
          {s.replace(/^https?:\/\/(www\.)?/, "")}
        </a>
      );
    }
    case "domain":
      return v ? (
        <Link href={`/domains?q=${encodeURIComponent(String(v))}`} className="text-accent hover:underline">
          {String(v)}
        </Link>
      ) : (
        muted
      );
    case "status":
      return v ? <Badge tone={STATUS_TONE[v as keyof typeof STATUS_TONE] ?? "neutral"}>{String(v)}</Badge> : muted;
    default:
      return v == null || v === "" ? muted : String(v);
  }
}

function SelectBox({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="size-3.5 accent-accent"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate && !checked;
      }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

type Selection = { selected: Set<string>; setSelected: Dispatch<SetStateAction<Set<string>>> };
const SelectionContext = createContext<Selection | null>(null);

function useSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("SelectionContext missing");
  return ctx;
}

function SelectOne({ keyword }: { keyword: string }) {
  const { selected, setSelected } = useSelection();
  return (
    <SelectBox
      label={`Select ${keyword}`}
      checked={selected.has(keyword)}
      onChange={(on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (on) next.add(keyword);
          else next.delete(keyword);
          return next;
        })
      }
    />
  );
}

function SelectAll({ keywords }: { keywords: string[] }) {
  const { selected, setSelected } = useSelection();
  const all = keywords.length > 0 && keywords.every((k) => selected.has(k));
  return (
    <SelectBox
      label="Select all rows"
      checked={all}
      indeterminate={selected.size > 0}
      onChange={(on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const k of keywords) {
            if (on) next.add(k);
            else next.delete(k);
          }
          return next;
        })
      }
    />
  );
}

/**
 * Keyword table with row selection. Selected keywords can be added to a saved list,
 * copied to the clipboard (for pasting into rank tracking), or removed from a list.
 */
export function KeywordGrid({
  rows,
  columns,
  filename,
  lists,
  market,
  source,
  removeFromListId,
  initialSort,
  toolbar,
}: {
  rows: Row[];
  columns: GridColumn[];
  filename: string;
  /** Lists of the current project; null when there is no project (saving disabled). */
  lists: { id: number; name: string }[] | null;
  /** The market these rows were researched in; saved with each keyword. Required when `lists` is set. */
  market?: Market;
  source?: string;
  /** When set, the grid offers "Remove" for this list instead of "Add to list". */
  removeFromListId?: number;
  initialSort?: { key: string; desc?: boolean };
  toolbar?: ReactNode;
}) {
  const timeZone = useTimeZone();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(lists?.[0] ? String(lists[0].id) : "new");
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const defs = useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "_select",
        enableSorting: false,
        header: ({ table }) => <SelectAll keywords={table.getFilteredRowModel().rows.map((r) => r.original.keyword)} />,
        cell: ({ row }) => <SelectOne keyword={row.original.keyword} />,
        meta: { width: 32 },
      },
      ...columns.map<ColumnDef<Row>>((c) => ({
        id: c.key,
        accessorFn: (r) => r[c.key],
        header: c.label,
        sortUndefined: "last",
        cell: ({ row }) => cell(c, row.original, timeZone, market),
        meta: { align: c.align ?? (NUMERIC.has(c.format ?? "") ? "right" : "left") },
      })),
    ],
    [columns, timeZone, market],
  );

  const chosen = rows.filter((r) => selected.has(r.keyword));
  const count = chosen.length;

  function flash(text: string) {
    setMessage(text);
    setTimeout(() => setMessage(null), 4000);
  }

  function copy() {
    const list = (count ? chosen : rows).map((r) => r.keyword).join("\n");
    navigator.clipboard.writeText(list).then(
      () => flash(`Copied ${formatNumber(count || rows.length)} keywords`),
      () => flash("Clipboard blocked by the browser"),
    );
  }

  function save() {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    startTransition(async () => {
      try {
        const res = await addToList({
          listId: target === "new" ? undefined : Number(target),
          newName: target === "new" ? newName.trim() || undefined : undefined,
          source,
          market: market!,
          items: chosen.map((r) => ({
            keyword: r.keyword,
            volume: num(r.volume) == null ? null : Math.round(num(r.volume)!),
            kd: num(r.kd),
            cpc: num(r.cpc),
            competition: num(r.competition),
            intent: typeof r.intent === "string" ? r.intent : null,
          })),
        });
        if ("error" in res) return flash(res.error);
        flash(`Added ${res.added} to “${res.name}”${res.added < count ? ` (${count - res.added} already there)` : ""}`);
        setSelected(new Set());
        setNewName("");
        setTarget(String(res.listId));
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function remove() {
    startTransition(async () => {
      const refused = await removeFromList(removeFromListId!, chosen.map((r) => r.keyword));
      if (refused) return flash(refused.error);
      setSelected(new Set());
    });
  }

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {toolbar}
      <span className="text-xs text-muted">{count ? `${formatNumber(count)} selected` : removeFromListId != null ? "Select rows to remove" : lists && market ? "Select rows to save" : "Select rows to copy"}</span>
      {removeFromListId != null ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            remove();
          }}
        >
          {/* Keyed on the count: removing clears the selection, and that puts the button back. */}
          <ConfirmSubmit key={count} variant="danger" disabled={!count} pending={pending} question={`Remove ${formatNumber(count)} ${count === 1 ? "keyword" : "keywords"} from this list?`} confirmLabel="Remove">
            Remove
          </ConfirmSubmit>
        </form>
      ) : lists && market ? (
        <>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} className="h-7 text-xs" aria-label="Keyword list">
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value="new">New list…</option>
          </Select>
          {target === "new" && (
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="List name" className="h-7 w-36 text-xs" aria-label="New list name" />
          )}
          <Button size="sm" disabled={!count || pending || (target === "new" && !newName.trim())} onClick={save}>
            Add to list
          </Button>
        </>
      ) : null}
      <Button variant="secondary" size="sm" onClick={copy} disabled={!rows.length} title="One keyword per line, ready to paste into rank tracking">
        {count ? "Copy selected" : "Copy all"}
      </Button>
      {message && <span className="text-xs text-muted">{message}</span>}
    </div>
  );

  return (
    <SelectionContext.Provider value={{ selected, setSelected }}>
      <DataTableCore columns={defs} rows={rows} csvColumns={columns} filename={filename} initialSort={initialSort} toolbar={actions} />
    </SelectionContext.Provider>
  );
}
