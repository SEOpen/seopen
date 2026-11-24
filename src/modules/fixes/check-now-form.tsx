"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { RefusalText } from "@/components/ui/refusal-text";
import type { CheckNowState } from "./actions";

/**
 * A fix row's Check now. Fetching the live page and asking Search Console takes a few seconds, and a
 * page already checked today looks the same afterwards, so it says it's checking and then what it found.
 */
export function CheckNowForm({ action, id }: { action: (prev: CheckNowState, form: FormData) => Promise<CheckNowState>; id: number }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <form action={formAction}>
        <input type="hidden" name="id" value={id} />
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          {pending ? "Checking…" : "Check now"}
        </Button>
      </form>
      {!pending && state.error && (
        <p role="alert" className="max-w-[60ch] text-xs [overflow-wrap:anywhere] text-bad">
          <RefusalText text={state.error} />
        </p>
      )}
      {!pending && state.ok && (
        <p role="status" className="max-w-[60ch] text-xs [overflow-wrap:anywhere] text-secondary">
          {state.ok}
        </p>
      )}
    </div>
  );
}
