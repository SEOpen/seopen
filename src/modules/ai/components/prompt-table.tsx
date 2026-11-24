"use client";

import { Check, ChevronDown, ChevronRight, ChevronUp, Trash2, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useId, useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { Input, Select } from "@/components/ui/input";
import { csvCell } from "@/lib/csv";
import { formatNumber, formatPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { deletePrompts, setPromptsTopic } from "../actions";
import { PLATFORMS } from "../platforms";

export interface Cell {
  status: string;
  mentioned: boolean | null;
  cited: boolean | null;
  position: number | null;
  error: string | null;
}

export type PromptTableRow = {
  id: number;
  prompt: string;
  keyword: string | null;
  topic: string | null;
  /** The prompt names our brand, so its answers name us almost by definition. */
  branded: boolean;
  active: boolean;
  platforms: string[];
  results: Record<string, Cell | undefined>;
  /** The newest weekly AI Overview check: what it saw, and its day ("Nov 2"). Rankings looks daily, so it can see otherwise. */
  aio: { present: boolean | null; cited: boolean | null; day: string } | null;
  mentionedOn: number;
  citedOn: number;
  checkedOn: number;
};

const NO_TOPIC = "No topic";

/** Sort key: mentioned and cited first, then mentioned, then checked, then pending. */
const score = (c?: Cell) => (!c ? -2 : c.status === "pending" ? -1 : c.status === "failed" ? -1 : (c.mentioned ? 2 : 0) + (c.cited ? 1 : 0));

type SortKey = "prompt" | "aio" | "mentionedOn" | (typeof PLATFORMS)[number]["key"];
const sortValue = (r: PromptTableRow, key: SortKey): number | string =>
  key === "prompt"
    ? r.prompt.toLowerCase()
    : key === "aio"
      ? r.aio
        ? (r.aio.present ? 1 : 0) + (r.aio.cited ? 1 : 0)
        : -1
      : key === "mentionedOn"
        ? r.checkedOn
          ? r.mentionedOn / r.checkedOn
          : -1
        : score(r.results[key]);

/** A dash for a cell that doesn't apply, so it can't read as a result. */
function NotAsked({ label }: { label: string }) {
  return (
    <span className="text-muted" title={label}>
      <span aria-hidden>–</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function PlatformCell({ cell, tracked }: { cell?: Cell; tracked: boolean }) {
  if (!tracked) return <NotAsked label="Not asked on this platform" />;
  if (!cell) return <span className="text-xs text-muted">not run</span>;
  if (cell.status === "pending") return <span className="text-xs text-muted">running…</span>;
  if (cell.status === "failed")
    return (
      // The reason says whether running it again will help, so it can't wait for a hover.
      <span className="block w-40 text-xs whitespace-normal">
        <span className="text-bad">failed</span>
        {cell.error && <span className="mt-0.5 block text-secondary [overflow-wrap:anywhere]">{cell.error}</span>}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5">
      {cell.mentioned ? (
        <span className="inline-flex items-center gap-0.5 text-secondary" title="Your brand is named">
          <Check aria-hidden className="size-4" strokeWidth={1.5} />
          <span className="sr-only">Named</span>
          {cell.position ? <span className="data">#{cell.position}</span> : null}
        </span>
      ) : (
        <span className="inline-flex text-muted" title="Not named">
          <X aria-hidden className="size-4" strokeWidth={1.5} />
          <span className="sr-only">Not named</span>
        </span>
      )}
      {cell.cited && <Badge tone="accent">cited</Badge>}
    </span>
  );
}

function AioCell({ row }: { row: PromptTableRow }) {
  const a = row.aio;
  if (!row.keyword) return <NotAsked label="No AI Overview keyword" />;
  if (!a) return <span className="text-xs text-muted">not checked yet</span>;
  if (!a.present) return <span className="text-xs text-muted">none on {a.day}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      {a.cited ? <Badge tone="accent">shown · cited</Badge> : <Badge>shown</Badge>}
      <span className="text-xs text-muted">{a.day}</span>
    </span>
  );
}

/** Mention and cited rates of a group's active prompts, over their latest answers. */
function rates(rows: PromptTableRow[]) {
  const live = rows.filter((r) => r.active);
  const checked = live.reduce((n, r) => n + r.checkedOn, 0);
  return {
    checked,
    mentioned: checked ? live.reduce((n, r) => n + r.mentionedOn, 0) / checked : null,
    cited: checked ? live.reduce((n, r) => n + r.citedOn, 0) / checked : null,
  };
}

function csv(rows: PromptTableRow[]): string {
  const head = ["Prompt", "Topic", "Branded", "AIO keyword", "Mentioned on", "Cited on", "Checked on"];
  return [head, ...rows.map((r) => [r.prompt, r.topic, r.branded ? "yes" : "no", r.keyword, r.mentionedOn, r.citedOn, r.checkedOn])].map((l) => l.map(csvCell).join(",")).join("\n");
}

function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Tracked prompts grouped by topic, each group with its mention and cited rates and a toggle.
 * Rows can be filtered by text and branded/non-branded, sorted within groups, deleted one by one,
 * and selected to set or clear their topic or delete them in one go.
 */
export function PromptTable({ projectId, rows }: { projectId: number; rows: PromptTableRow[] }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "branded" | "non_branded">("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [topicInput, setTopicInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const topics = useMemo(() => [...new Set(rows.map((r) => r.topic).filter((t): t is string => !!t))].sort((a, b) => a.localeCompare(b)), [rows]);
  const grouped = topics.length > 0;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter(
      (r) =>
        (kind === "all" || (kind === "branded") === r.branded) &&
        (!q || r.prompt.toLowerCase().includes(q) || (r.keyword ?? "").toLowerCase().includes(q) || (r.topic ?? "").toLowerCase().includes(q)),
    );
    if (!sort) return list;
    return [...list].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      const c = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : Number(x) - Number(y);
      return sort.desc ? -c : c;
    });
  }, [rows, query, kind, sort]);

  const groups = useMemo(() => {
    if (!grouped) return [{ topic: NO_TOPIC, rows: visible }];
    const by = new Map<string, PromptTableRow[]>();
    for (const t of topics) by.set(t, []);
    by.set(NO_TOPIC, []);
    for (const r of visible) by.get(r.topic ?? NO_TOPIC)!.push(r);
    return [...by.entries()].filter(([, list]) => list.length).map(([topic, list]) => ({ topic, rows: list }));
  }, [grouped, topics, visible]);

  const brandedCount = rows.filter((r) => r.branded).length;
  const visibleIds = visible.map((r) => r.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((i) => selected.has(i));
  // A column empty in every row says nothing: a platform no prompt is asked on, or AI Overview with no keywords.
  const platforms = PLATFORMS.filter((p) => rows.some((r) => r.platforms.includes(p.key)));
  const showAio = rows.some((r) => r.keyword);
  const colSpan = platforms.length + (showAio ? 5 : 4);

  const toggle = (ids: number[], on: boolean) => {
    const next = new Set(selected);
    for (const i of ids) {
      if (on) next.add(i);
      else next.delete(i);
    }
    setSelected(next);
  };

  const assign = (topic: string | null) =>
    start(async () => {
      setError(null);
      try {
        await setPromptsTopic(projectId, [...selected], topic);
        setSelected(new Set());
        setTopicInput("");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  const remove = (ids: number[]) =>
    start(async () => {
      setError(null);
      try {
        await deletePrompts(projectId, ids);
        setSelected((now) => new Set([...now].filter((i) => !ids.includes(i))));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });

  const header = (key: SortKey, label: string, align: "left" | "right" = "left") => {
    const on = sort?.key === key;
    return (
      <th aria-sort={on ? (sort!.desc ? "descending" : "ascending") : undefined} className={cn("h-9 px-3 font-medium whitespace-nowrap", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          onClick={() => setSort(on ? (sort!.desc ? null : { key, desc: true }) : { key, desc: key !== "prompt" })}
          className="relative inline-flex items-center rounded-sm hover:text-fg focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {label}
          {/* Out of the flow, in the cell's padding: the label stays on the column's edge and sorting moves nothing. */}
          {on && (
            <span aria-hidden className={cn("absolute top-1/2 -translate-y-1/2", align === "right" ? "right-full" : "left-full")}>
              {sort!.desc ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
            </span>
          )}
        </button>
      </th>
    );
  };

  return (
    <div className="overflow-hidden panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter prompts…" aria-label="Filter prompts" className="h-8 w-full @2xl/main:w-64" />
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Branded or non-branded" className="h-8 w-auto text-sm">
          <option value="all">All prompts</option>
          <option value="non_branded">Non-branded ({formatNumber(rows.length - brandedCount)})</option>
          <option value="branded">Branded ({formatNumber(brandedCount)})</option>
        </Select>
        <span className="data ml-auto text-muted">
          {formatNumber(visible.length)} {visible.length === 1 ? "prompt" : "prompts"}
        </span>
        <Button variant="secondary" size="sm" onClick={() => download("ai-prompts.csv", csv(visible))} disabled={!visible.length}>
          Export CSV
        </Button>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft bg-surface-2/60 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Input
            value={topicInput}
            onChange={(e) => setTopicInput(e.target.value)}
            list={`${id}-topics`}
            maxLength={60}
            placeholder="Topic"
            aria-label="Topic for the selected prompts"
            className="h-8 w-48"
            onKeyDown={(e) => {
              if (e.key === "Enter" && topicInput.trim()) assign(topicInput);
            }}
          />
          <datalist id={`${id}-topics`}>
            {topics.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <Button size="sm" disabled={pending || !topicInput.trim()} onClick={() => assign(topicInput)}>
            Set topic
          </Button>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => assign(null)}>
            Clear topic
          </Button>
          <form action={() => remove([...selected])}>
            <ConfirmSubmit variant="danger" pending={pending} confirmLabel="Delete" question={`Delete ${selected.size === 1 ? "this prompt" : `these ${selected.size} prompts`} and all stored answers?`}>
              Delete
            </ConfirmSubmit>
          </form>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSelected(new Set())}>
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="border-b border-line-soft px-3 py-2 text-xs text-bad">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="table-head">
            <tr>
              <th className="h-9 w-8 pr-0 pl-3 text-left">
                <input
                  type="checkbox"
                  className="accent-[var(--accent-fill)]"
                  aria-label="Select all shown prompts"
                  checked={allSelected}
                  onChange={(e) => toggle(visibleIds, e.target.checked)}
                />
              </th>
              {header("prompt", "Prompt")}
              {platforms.map((p) => (
                <Fragment key={p.key}>{header(p.key, p.label)}</Fragment>
              ))}
              {showAio && header("aio", "AI Overview")}
              {header("mentionedOn", "Named on", "right")}
              <th className="sticky right-0 h-9 bg-surface px-3">
                <span className="sr-only">Delete</span>
              </th>
            </tr>
          </thead>
          {groups.map((g) => {
            const open = !collapsed.has(g.topic);
            const r = rates(g.rows);
            const ids = g.rows.map((x) => x.id);
            const bodyId = `${id}-${g.topic}`;
            return (
              <Fragment key={g.topic}>
                {grouped && (
                  <tbody>
                    <tr className="border-t border-line-soft bg-surface-2/40">
                      <td className="py-2 pr-0 pl-3">
                        <input
                          type="checkbox"
                          className="accent-[var(--accent-fill)]"
                          aria-label={`Select the prompts in ${g.topic}`}
                          checked={ids.every((i) => selected.has(i))}
                          onChange={(e) => toggle(ids, e.target.checked)}
                        />
                      </td>
                      <td colSpan={colSpan - 1} className="px-3 py-2">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={bodyId}
                          onClick={() => {
                            const next = new Set(collapsed);
                            if (open) next.add(g.topic);
                            else next.delete(g.topic);
                            setCollapsed(next);
                          }}
                          className="sticky left-3 flex w-full max-w-[calc(100cqi-6rem)] flex-wrap items-center gap-x-3 gap-y-0.5 rounded-sm text-left focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent @2xl/main:static @2xl/main:max-w-none"
                        >
                          <span className="inline-flex items-center gap-1 font-medium">
                            {open ? <ChevronDown aria-hidden className="size-3.5 text-muted" strokeWidth={1.5} /> : <ChevronRight aria-hidden className="size-3.5 text-muted" strokeWidth={1.5} />}
                            <span className={g.topic === NO_TOPIC ? "text-muted" : undefined}>{g.topic}</span>
                          </span>
                          <span className="text-xs text-muted">
                            {g.rows.length} prompt{g.rows.length === 1 ? "" : "s"} ·{" "}
                            {r.checked > 0 ? (
                              <>
                                {formatNumber(r.checked)} answer{r.checked === 1 ? "" : "s"} · named <span className="text-fg">{formatPct(r.mentioned, 0)}</span> · cited{" "}
                                <span className="text-fg">{formatPct(r.cited, 0)}</span>
                              </>
                            ) : (
                              "no answers yet"
                            )}
                          </span>
                        </button>
                      </td>
                    </tr>
                  </tbody>
                )}
                <tbody id={bodyId} hidden={!open}>
                  {g.rows.map((row) => (
                    <tr key={row.id} className="group/row border-t border-line-soft hover:bg-surface-2/60">
                      <td className="py-2.5 pr-0 pl-3 align-top">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-[var(--accent-fill)]"
                          aria-label={`Select “${row.prompt}”`}
                          checked={selected.has(row.id)}
                          onChange={(e) => toggle([row.id], e.target.checked)}
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="max-w-[28rem] min-w-[14rem]">
                          <Link href={`/ai/prompts/${row.id}`} className={cn("underline-offset-4 hover:underline", row.active ? "text-fg" : "text-muted line-through")}>
                            {row.prompt}
                          </Link>
                          {row.branded && (
                            <Badge className="ml-1.5 align-[1px]" title="The prompt names your brand, so it isn't counted in Overview by default">
                              Branded
                            </Badge>
                          )}
                          {row.keyword && <div className="truncate text-xs text-muted">AI Overview keyword: {row.keyword}</div>}
                        </div>
                      </td>
                      {platforms.map((p) => (
                        <td key={p.key} className="px-3 py-2.5">
                          <PlatformCell cell={row.results[p.key]} tracked={row.platforms.includes(p.key)} />
                        </td>
                      ))}
                      {showAio && (
                        <td className="px-3 py-2.5">
                          <AioCell row={row} />
                        </td>
                      )}
                      <td className="data px-3 py-2.5 text-right whitespace-nowrap">
                        {row.mentionedOn} of {row.checkedOn}
                      </td>
                      {/* Quiet until the row is hovered or focused where a pointer can hover; always there on touch. */}
                      <td className="sticky right-0 bg-surface px-3 py-1.5 text-right whitespace-nowrap">
                        <form action={() => remove([row.id])} className="group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:hover)]:opacity-0">
                          <ConfirmSubmit variant="ghost" pending={pending} confirmLabel="Delete" question="Delete with its answers?" aria-label={`Delete “${row.prompt}”`}>
                            <Trash2 aria-hidden className="size-3.5" strokeWidth={1.5} />
                          </ConfirmSubmit>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Fragment>
            );
          })}
          {!visible.length && (
            <tbody>
              <tr>
                <td colSpan={colSpan} className="px-3 py-10 text-center text-muted">
                  No prompts match
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
