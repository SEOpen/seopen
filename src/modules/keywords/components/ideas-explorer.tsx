"use client";

import { Minus, Plus, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { INTENT_TONE } from "../format";
import type { Market } from "../requests";
import { filterRows, wordGroups, type KeywordRow, type Range } from "../transform";
import { KeywordGrid, type GridColumn } from "./keyword-grid";

const RANGES = [
  { key: "volume", label: "Volume" },
  { key: "kd", label: "Difficulty" },
  { key: "cpc", label: "Cost per click" },
  { key: "words", label: "Words" },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

const parse = (s: string) => (s.trim() === "" || Number.isNaN(Number(s)) ? null : Number(s));

const chip = "rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Idea table with range filters, intent toggles and a word-group sidebar. All filtering is client-side and free. */
export function IdeasExplorer({
  rows,
  seed,
  columns,
  lists,
  market,
  source,
  filename,
}: {
  rows: KeywordRow[];
  seed: string;
  columns: GridColumn[];
  lists: { id: number; name: string }[] | null;
  market: Market;
  source: string;
  filename: string;
}) {
  const [ranges, setRanges] = useState<Record<RangeKey, [string, string]>>({
    volume: ["", ""],
    kd: ["", ""],
    cpc: ["", ""],
    words: ["", ""],
  });
  const [intents, setIntents] = useState<string[]>([]);
  const [include, setInclude] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [groupQuery, setGroupQuery] = useState("");

  const asRange = (k: RangeKey): Range => [parse(ranges[k][0]), parse(ranges[k][1])];
  const filtered = filterRows(rows, {
    volume: asRange("volume"),
    kd: asRange("kd"),
    cpc: asRange("cpc"),
    words: asRange("words"),
    intents,
    include,
    exclude,
  });
  // Groups describe the current result set minus the group filters themselves, so counts stay meaningful.
  const groupBase = filterRows(rows, { volume: asRange("volume"), kd: asRange("kd"), cpc: asRange("cpc"), words: asRange("words"), intents });
  const groups = wordGroups(groupBase, seed);
  const shownGroups = groups.filter((g) => !groupQuery || g.word.includes(groupQuery.toLowerCase())).slice(0, 80);

  const active = include.length + exclude.length + intents.length + Object.values(ranges).flat().filter(Boolean).length;

  function toggleGroup(word: string, excluding: boolean) {
    if (excluding) {
      setInclude((p) => p.filter((w) => w !== word));
      setExclude((p) => (p.includes(word) ? p.filter((w) => w !== word) : [...p, word]));
    } else {
      setExclude((p) => p.filter((w) => w !== word));
      setInclude((p) => (p.includes(word) ? p.filter((w) => w !== word) : [...p, word]));
    }
  }

  function reset() {
    setRanges({ volume: ["", ""], kd: ["", ""], cpc: ["", ""], words: ["", ""] });
    setIntents([]);
    setInclude([]);
    setExclude([]);
  }

  return (
    <div className="grid gap-4 @3xl/main:grid-cols-[15rem_minmax(0,1fr)]">
      {/* Short on a narrow screen, so the table isn't pushed a screen down. */}
      <aside className="panel flex max-h-64 flex-col overflow-hidden @3xl/main:max-h-[44rem]">
        <div className="border-b border-line-soft px-3 py-2">
          <div className="text-xs font-medium">Word groups</div>
          <p className="mt-0.5 text-xs text-muted">Click to include. Alt-click to exclude.</p>
          <Input value={groupQuery} onChange={(e) => setGroupQuery(e.target.value)} placeholder="Find a word…" className="mt-2 h-7 text-xs" aria-label="Find a word group" />
        </div>
        <ul className="flex-1 overflow-y-auto py-1 text-sm">
          {shownGroups.map((g) => {
            const inc = include.includes(g.word);
            const exc = exclude.includes(g.word);
            return (
              <li key={g.word}>
                <button
                  type="button"
                  onClick={(e) => toggleGroup(g.word, e.altKey || e.metaKey || e.ctrlKey)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-1 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                    inc && "bg-accent-subtle text-accent",
                    exc && "text-bad line-through",
                  )}
                  title={`${g.count} keywords · ${formatNumber(g.volume)} searches`}
                >
                  <span className="truncate">{g.word}</span>
                  <span className="data text-muted">{g.count}</span>
                </button>
              </li>
            );
          })}
          {!shownGroups.length && <li className="px-3 py-4 text-xs text-muted">No shared words</li>}
        </ul>
      </aside>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {RANGES.map((r) => (
            <fieldset key={r.key} className="flex flex-col gap-1">
              <legend className="text-xs font-medium text-muted">{r.label}</legend>
              <div className="flex items-center gap-1">
                {(["min", "max"] as const).map((side, i) => (
                  <Input
                    key={side}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    value={ranges[r.key][i]}
                    onChange={(e) =>
                      setRanges((p) => {
                        const next: [string, string] = [...p[r.key]];
                        next[i] = e.target.value;
                        return { ...p, [r.key]: next };
                      })
                    }
                    placeholder={side}
                    aria-label={`${r.label} ${side}`}
                    className="h-7 w-20 px-2 text-xs"
                  />
                ))}
              </div>
            </fieldset>
          ))}
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium text-muted">Intent</legend>
            <div className="flex flex-wrap gap-1">
              {Object.keys(INTENT_TONE).map((intent) => {
                const on = intents.includes(intent);
                return (
                  <button
                    key={intent}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setIntents((p) => (on ? p.filter((i) => i !== intent) : [...p, intent]))}
                    className={cn(
                      "h-7 rounded-md border px-2 text-xs capitalize focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      on ? "border-accent bg-accent-subtle text-accent" : "border-line text-muted hover:text-fg",
                    )}
                  >
                    {intent}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {active > 0 && (
            <Button variant="ghost" size="sm" onClick={reset} className="ml-auto">
              Clear filters ({active})
            </Button>
          )}
        </div>

        {(include.length > 0 || exclude.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {include.map((w) => (
              <button key={w} type="button" onClick={() => toggleGroup(w, false)} aria-label={`Stop including ${w}`} className={chip}>
                <Badge tone="accent">
                  <Plus aria-hidden className="size-3" strokeWidth={1.5} />
                  {w}
                  <X aria-hidden className="size-3" strokeWidth={1.5} />
                </Badge>
              </button>
            ))}
            {exclude.map((w) => (
              <button key={w} type="button" onClick={() => toggleGroup(w, true)} aria-label={`Stop excluding ${w}`} className={chip}>
                <Badge tone="bad">
                  <Minus aria-hidden className="size-3" strokeWidth={1.5} />
                  {w}
                  <X aria-hidden className="size-3" strokeWidth={1.5} />
                </Badge>
              </button>
            ))}
          </div>
        )}

        <KeywordGrid rows={filtered} columns={columns} lists={lists} market={market} source={source} filename={filename} initialSort={{ key: "volume", desc: true }} />
      </div>
    </div>
  );
}
