"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { RefusalText } from "@/components/ui/refusal-text";
import { addKeywords, type ActionState } from "../actions";
import type { SavedList } from "../queries";

/**
 * Paste keywords, or pull them from a saved keyword list. Tags and device apply
 * to both; the button that submits decides the source.
 */
export function AddKeywordsForm({ projectId, lists }: { projectId: number; lists: SavedList[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addKeywords.bind(null, projectId), {});
  const usable = lists.filter((l) => l.items > 0);
  return (
    // Remount on each result so the fields show what was kept (empty after a success).
    <form key={JSON.stringify(state)} action={action} className="flex flex-col gap-3">
      <Textarea
        name="keywords"
        rows={5}
        placeholder="One keyword per line, or separated by commas"
        aria-label="Keywords"
        defaultValue={state.keywords}
        aria-invalid={!!state.error}
        aria-describedby={state.error || state.ok ? "add-keywords-result" : undefined}
        autoFocus={!!state.error}
      />
      <div className="flex flex-wrap items-end gap-2">
        <Label className="flex-1">
          Tags <span className="font-normal text-muted">(optional)</span>
          <Input name="tags" placeholder="e.g. core, brand" defaultValue={state.tags} />
        </Label>
        <Label>
          Device
          <Select name="device" defaultValue="desktop">
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </Select>
        </Label>
        <Button type="submit" name="source" value="paste" disabled={pending}>
          Add
        </Button>
      </div>
      {lists.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Label className="min-w-0 flex-1">
            Or from a saved list
            <Select name="listId" defaultValue={usable[0]?.id ?? ""} disabled={!usable.length}>
              {lists.map((l) => (
                <option key={l.id} value={l.id} disabled={!l.items}>
                  {l.name} ({l.items} {l.items === 1 ? "keyword" : "keywords"})
                </option>
              ))}
            </Select>
          </Label>
          <Button type="submit" name="source" value="list" variant="secondary" disabled={pending || !usable.length}>
            Add from list
          </Button>
        </div>
      )}
      {state.error && (
        <div id="add-keywords-result" role="alert" className="flex flex-wrap items-center gap-2 text-xs text-bad">
          <span>
            <RefusalText text={state.error} />
          </span>
          {state.room != null && (
            <Button type="submit" name="fit" value={state.room} size="sm" variant="secondary" disabled={pending}>
              Add the first {state.room.toLocaleString("en-US")}
            </Button>
          )}
        </div>
      )}
      {state.ok && (
        <p id="add-keywords-result" role="status" className="text-xs text-secondary">
          {state.ok}
        </p>
      )}
    </form>
  );
}
