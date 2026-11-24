"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { RefusalText } from "@/components/ui/refusal-text";
import { logChangeAction, type LogChangeState } from "./actions";

/**
 * Log a change made without a fix on the list, such as a title rewritten by hand, so SEOpen checks it
 * reached the live page and measures it like any fix. The same op as MCP's record_change.
 */
export function LogChangeForm({ projectId, domain }: { projectId: number; domain: string }) {
  const [state, action, pending] = useActionState<LogChangeState, FormData>(logChangeAction.bind(null, projectId), {});
  const f = state.fields;
  const result = state.error || state.ok ? "log-change-result" : undefined;
  return (
    // Remount on each result so the fields show what was kept (empty after a success).
    <form key={JSON.stringify(state)} action={action} className="flex max-w-[72ch] flex-col gap-3">
      <Label>
        Pages
        <Textarea name="urls" rows={3} required placeholder={`/pricing\nhttps://${domain}/blog/post`} defaultValue={f?.urls} aria-describedby={result} />
        <span className="text-xs font-normal text-muted">One per line, as a path or a full URL on {domain}. Up to 50.</span>
      </Label>
      <Label>
        What changed
        <Input name="note" required maxLength={500} placeholder="Rewrote the title and intro" defaultValue={f?.note} />
      </Label>
      <Label>
        Text the live page should now contain <span className="font-normal text-muted">(optional)</span>
        <Input name="expect" maxLength={300} placeholder="The new title, for example" defaultValue={f?.expect} />
        <span className="text-xs font-normal text-muted">Without it, the change shows as live once the title, meta description or H1 differs from the page as it is now.</span>
      </Label>
      <Label>
        Commit <span className="font-normal text-muted">(optional)</span>
        <Input name="commit" maxLength={100} defaultValue={f?.commit} className="font-mono" />
      </Label>
      <div>
        <Button type="submit" disabled={pending}>
          Log the change
        </Button>
      </div>
      {state.error && (
        <p id="log-change-result" role="alert" className="text-xs text-bad">
          <RefusalText text={state.error} />
        </p>
      )}
      {state.ok && (
        <p id="log-change-result" role="status" className="text-xs text-secondary">
          {state.ok}
        </p>
      )}
      {!!state.skipped?.length && (
        <ul className="flex flex-col gap-1 text-xs text-secondary">
          {state.skipped.map((s) => (
            <li key={s.url} className="[overflow-wrap:anywhere]">
              <span className="data">{s.url}</span>: {s.why}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
