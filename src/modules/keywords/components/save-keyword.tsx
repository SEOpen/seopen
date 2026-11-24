"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { addToList } from "../actions";
import type { Market } from "../requests";
import type { KeywordRow } from "../transform";

/** Compact "save this keyword to a list" control for the keyword overview. */
export function SaveKeyword({ row, lists, market }: { row: KeywordRow; lists: { id: number; name: string }[]; market: Market }) {
  const [target, setTarget] = useState(lists[0] ? String(lists[0].id) : "new");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      try {
        const res = await addToList({
          listId: target === "new" ? undefined : Number(target),
          newName: target === "new" ? name.trim() : undefined,
          source: "keyword overview",
          market,
          items: [{ keyword: row.keyword, volume: row.volume, kd: row.kd, cpc: row.cpc, competition: row.competition, intent: row.intent }],
        });
        if ("error" in res) return setMessage(res.error);
        setMessage(res.added ? `Saved to “${res.name}”` : `Already in “${res.name}”`);
        setTarget(String(res.listId));
        setName("");
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={target} onChange={(e) => setTarget(e.target.value)} className="h-7 text-xs" aria-label="Keyword list">
        {lists.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
        <option value="new">New list…</option>
      </Select>
      {target === "new" && <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="List name" className="h-7 w-36 text-xs" aria-label="New list name" />}
      <Button size="sm" variant="secondary" onClick={save} disabled={pending || (target === "new" && !name.trim())}>
        Save to list
      </Button>
      {message && <span className="text-xs text-muted">{message}</span>}
    </div>
  );
}
