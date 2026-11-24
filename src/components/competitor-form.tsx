"use client";

import { useActionState } from "react";
import type { CompetitorFormState } from "@/app/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Adds one or more competitors (separated by spaces or commas) and says what was added or skipped. */
export function CompetitorForm({ action }: { action: (prev: CompetitorFormState, formData: FormData) => Promise<CompetitorFormState> }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          // Remount on each result: empty after a success, the typed text after an error.
          key={JSON.stringify(state)}
          name="domain"
          aria-label="Competitor website"
          placeholder="e.g. a-rival.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={state?.value}
          aria-invalid={!!state?.error}
          aria-describedby={state ? "competitor-result" : undefined}
          autoFocus={!!state?.error}
          required
        />
        <Button type="submit" disabled={pending}>
          Add
        </Button>
      </div>
      {state && (
        <p id="competitor-result" role={state.error ? "alert" : "status"} className={state.error ? "text-sm text-bad" : "text-sm text-muted"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
