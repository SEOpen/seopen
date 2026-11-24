"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { ActionProblem } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTableCore } from "@/components/ui/data-table";
import { Delta, Digits } from "@/components/ui/delta";
import { Input } from "@/components/ui/input";
import type { ActionRefusal } from "@/lib/action-result";
import { formatDay, formatNumber } from "@/lib/format";
import { removeKeywords, tagKeywords } from "../actions";
import { featureLabel } from "../features";
import type { Change } from "../metrics";
import { NotConfirmedBadge } from "./not-confirmed";

/** "3 keywords (a, b, c)", the first five named, for the delete question. */
export function stopTrackingQuestion(rows: { id: number; keyword: string }[], selected: ReadonlySet<number>): string {
  const names = rows.filter((r) => selected.has(r.id)).map((r) => r.keyword);
  const list = names.slice(0, 5).join(", ") + (names.length > 5 ? ` and ${names.length - 5} more` : "");
  return names.length === 1 ? `Stop tracking 1 keyword (${list}) and delete its history?` : `Stop tracking ${names.length} keywords (${list}) and delete their history?`;
}

export interface RankingRow extends Record<string, unknown> {
  id: number;
  keyword: string;
  tags: string[];
  device: string;
  position: number | null;
  start: number | null;
  delta: number | null;
  change: Change;
  url: string | null;
  volume: number | null;
  traffic: number;
  features: string[];
  owned: string[];
  /** "cited" | "present" | "none"; null when never checked. */
  aio: "cited" | "present" | "none" | null;
  /** The check `aio` comes from: the latest that loaded AI Overview sources, which can be older than `features`' check. */
  aioDate?: string | null;
  checked: boolean;
  /** The latest check couldn't confirm this keyword: `position` is the last one seen. */
  notChecked: boolean;
  /** `position` is beyond the latest check's depth; this is the date of the deeper check that saw it. */
  deeperCheckDate: string | null;
  /** How deep the latest check looked, so a keyword it didn't find can say so. */
  depth?: number | null;
  /** No look found it, but Search Console's average across every location is within the check's depth. */
  searchConsole?: number | null;
}

function ChangeCell({ row }: { row: RankingRow }) {
  if (row.change === "new") return <Badge tone="good">new</Badge>;
  if (row.change === "lost") return <Badge tone="bad">lost</Badge>;
  if (!row.delta) return <span className="text-muted">–</span>;
  return <Delta text={String(Math.abs(row.delta))} tone={row.delta > 0 ? "good" : "bad"} up={row.delta > 0} />;
}

/** `path` with the page's own params (range, place) and `extra`, so a link keeps what the page was showing. */
export function linkWith(path: string, params: Record<string, string> = {}, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ ...params, ...extra }).toString();
  return query ? `${path}?${query}` : path;
}

/** Left out on a phone so Keyword, Position and Change fit without scrolling. The CSV still has them. */
const WIDE_ONLY = { className: "@max-2xl/main:hidden" };

/** Columns only some rows can fill: empty in every row, they aren't drawn. */
const OPTIONAL: Record<string, (r: RankingRow) => boolean> = {
  tags: (r) => r.tags.length > 0,
  features: (r) => r.features.length > 0,
  aio: (r) => r.aio === "cited" || r.aio === "present",
};

/**
 * `mock`: drawn on the marketing site, where a keyword and its URL are plain text rather than links into the app.
 * `checkFailed`: the newest check failed, so a keyword with no result isn't about to get one on its own.
 */
/** `volumePlace`: where the search volumes are for, the project's city or its country, said on the column's header. */
export function RankingsTable({
  rows,
  projectId,
  mock = false,
  checkFailed = false,
  volumePlace,
  linkParams,
}: {
  rows: RankingRow[];
  projectId: number;
  mock?: boolean;
  checkFailed?: boolean;
  volumePlace?: string;
  /** The range and place the page shows, kept on its keyword and tag links. */
  linkParams?: Record<string, string>;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tag, setTag] = useState("");
  const [pending, start] = useTransition();
  // A read-only project refuses tag and delete changes; the reason shows beside the buttons.
  const [problem, setProblem] = useState<ActionRefusal | null>(null);
  const ids = [...selected];

  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns = useMemo<ColumnDef<RankingRow>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        // Selects only the rows the filter box leaves showing, so a bulk Delete never reaches rows out of sight.
        header: ({ table }) => {
          const shown = table.getFilteredRowModel().rows.map((r) => r.original.id);
          return (
            <input
              type="checkbox"
              aria-label={shown.length < rows.length ? `Select the ${shown.length} rows shown` : "Select all"}
              checked={shown.length > 0 && shown.every((id) => selected.has(id))}
              onChange={(e) =>
                setSelected((s) => {
                  const next = new Set(s);
                  for (const id of shown) {
                    if (e.target.checked) next.add(id);
                    else next.delete(id);
                  }
                  return next;
                })
              }
            />
          );
        },
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.keyword}`}
            checked={selected.has(row.original.id)}
            onChange={() => toggle(row.original.id)}
          />
        ),
        meta: { width: 32 },
      },
      {
        id: "keyword",
        accessorKey: "keyword",
        header: "Keyword",
        cell: ({ row }) => (
          <div className="flex min-w-24 flex-wrap items-center gap-1.5 @2xl/main:min-w-36 @2xl/main:flex-nowrap">
            {mock ? (
              <span>{row.original.keyword}</span>
            ) : (
              <Link href={linkWith(`/rank/${row.original.id}`, linkParams)} className="underline-offset-4 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
                {row.original.keyword}
              </Link>
            )}
            {row.original.device === "mobile" && <Badge>mobile</Badge>}
          </div>
        ),
      },
      {
        id: "tags",
        accessorFn: (r) => r.tags.join(", "),
        header: "Tags",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.tags.map((t) => (
              <Link key={t} href={linkWith("/rank", linkParams, { tag: t })}>
                <Badge>{t}</Badge>
              </Link>
            ))}
          </div>
        ),
        meta: WIDE_ONLY,
      },
      {
        id: "position",
        accessorFn: (r) => r.position ?? 999,
        header: "Position",
        sortUndefined: "last",
        cell: ({ row }) =>
          row.original.position != null ? (
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5 @2xl/main:flex-nowrap">
              {row.original.notChecked && <NotConfirmedBadge />}
              {row.original.deeperCheckDate && (
                <span title={`The latest check didn't look this deep. This position is from the deeper check on ${formatDay(row.original.deeperCheckDate)}.`}>
                  <Badge>weekly</Badge>
                </span>
              )}
              <span className="font-medium">{row.original.position}</span>
            </span>
          ) : (
            <span className="inline-flex flex-wrap items-center justify-end gap-1.5 text-muted @2xl/main:flex-nowrap">
              {row.original.searchConsole != null && (
                <span title={`No look found this keyword, but Search Console has it around ${row.original.searchConsole.toFixed(1)} across every location, so this check may have missed it.`}>
                  <Badge tone="warn">not found</Badge>
                </span>
              )}
              {!row.original.checked ? (
                <Digits text={checkFailed ? "not checked" : "pending"} />
              ) : row.original.searchConsole != null || row.original.depth == null ? (
                "–"
              ) : (
                <span className="font-sans whitespace-nowrap" title={`Not in the top ${row.original.depth} results on the latest check.`}>
                  {`not in top ${row.original.depth}`}
                </span>
              )}
            </span>
          ),
        meta: { align: "right" },
      },
      {
        id: "delta",
        accessorFn: (r) => r.delta ?? 0,
        header: "Change",
        cell: ({ row }) => <ChangeCell row={row.original} />,
        meta: { align: "right" },
      },
      {
        id: "url",
        accessorFn: (r) => r.url ?? "",
        header: "URL",
        cell: ({ row }) =>
          row.original.url && mock ? (
            <span className="block max-w-[12rem] overflow-hidden text-ellipsis whitespace-nowrap text-muted">{row.original.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</span>
          ) : row.original.url ? (
            <a
              href={row.original.url}
              target="_blank"
              rel="noreferrer"
              className="block max-w-[12rem] truncate text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
              title={row.original.url}
            >
              {row.original.url.replace(/^https?:\/\/[^/]+/, "") || "/"}
            </a>
          ) : (
            <span className="text-muted">–</span>
          ),
        meta: WIDE_ONLY,
      },
      {
        id: "volume",
        accessorFn: (r) => r.volume ?? -1,
        header: () => (volumePlace ? <span title={`Searches a month in ${volumePlace}`}>Volume</span> : "Volume"),
        cell: ({ row }) => formatNumber(row.original.volume),
        meta: { align: "right" },
      },
      {
        id: "traffic",
        accessorKey: "traffic",
        header: "Est. traffic",
        cell: ({ row }) => (!row.original.traffic ? "–" : row.original.traffic < 10 ? row.original.traffic.toFixed(1) : formatNumber(Math.round(row.original.traffic))),
        meta: { align: "right" },
      },
      {
        id: "features",
        accessorFn: (r) => r.features.length,
        header: "Result features",
        // One line, so the rows stay even: yours first, then a count that names the rest on hover.
        cell: ({ row }) => {
          const { features, owned } = row.original;
          const [first, ...rest] = [...features].sort((a, b) => Number(owned.includes(b)) - Number(owned.includes(a)));
          if (!first) return null;
          return (
            <div className="flex items-center gap-1 whitespace-nowrap">
              <Badge tone={owned.includes(first) ? "accent" : "neutral"} title={owned.includes(first) ? "We appear in it" : undefined}>
                {featureLabel(first)}
              </Badge>
              {rest.length > 0 && (
                <span className="text-xs text-muted" title={rest.map(featureLabel).join(", ")}>
                  +{rest.length}
                </span>
              )}
            </div>
          );
        },
        meta: WIDE_ONLY,
      },
      {
        id: "aio",
        accessorFn: (r) => (r.aio === "cited" ? 2 : r.aio === "present" ? 1 : 0),
        header: "AI Overview",
        cell: ({ row }) =>
          row.original.aio === "cited" ? (
            <Badge tone="good">cited</Badge>
          ) : row.original.aio === "present" ? (
            <Badge>not cited</Badge>
          ) : (
            <span className="text-muted">–</span>
          ),
      },
    ],
    [rows, selected, mock, checkFailed, volumePlace, linkParams],
  );
  const shownColumns = useMemo(() => columns.filter((c) => !OPTIONAL[c.id ?? ""] || rows.some(OPTIONAL[c.id!])), [columns, rows]);

  const toolbar = selected.size ? (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">{selected.size} selected</span>
      <Input value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag to add to or remove from the selected keywords" placeholder="tag" className="h-7 w-28 text-xs" />
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || !tag.trim()}
        onClick={() => start(async () => setProblem((await tagKeywords(projectId, ids, tag)) ?? null))}
      >
        Add tag
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={pending || !tag.trim()}
        onClick={() => start(async () => setProblem((await tagKeywords(projectId, ids, tag, true)) ?? null))}
      >
        Remove tag
      </Button>
      <form
        action={() =>
          start(async () => {
            const refused = (await removeKeywords(projectId, ids)) ?? null;
            setProblem(refused);
            if (!refused) setSelected(new Set());
          })
        }
      >
        <ConfirmSubmit variant="danger" pending={pending} confirmLabel="Delete" question={stopTrackingQuestion(rows, selected)}>
          Delete
        </ConfirmSubmit>
      </form>
      <ActionProblem result={problem} />
    </div>
  ) : null;

  return (
    <DataTableCore
      columns={shownColumns}
      rows={rows}
      filename="rankings"
      initialSort={{ key: "position" }}
      pageSize={mock ? 11 : undefined}
      toolbar={toolbar}
      csvColumns={[
        { key: "keyword", label: "Keyword" },
        { key: "tags", label: "Tags" },
        { key: "device", label: "Device" },
        { key: "position", label: "Position" },
        { key: "start", label: "Start position" },
        { key: "delta", label: "Change" },
        { key: "url", label: "URL" },
        { key: "volume", label: "Volume" },
        { key: "traffic", label: "Est. traffic" },
        { key: "features", label: "Result features" },
        { key: "aio", label: "AI Overview" },
      ]}
    />
  );
}
