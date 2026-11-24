"use client";

import { useActionState } from "react";
import { addAdminFromForm, type AdminFormState } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { Input } from "@/components/ui/input";

/** "Add an admin" on Admin → Users: an email in, what happened written under it. */
export function AddAdminForm({ firstAdmin }: { firstAdmin: boolean }) {
  const [state, formAction, pending] = useActionState<AdminFormState, FormData>(addAdminFromForm, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          key={JSON.stringify(state)}
          name="email"
          type="email"
          aria-label="Admin email"
          placeholder="e.g. name@example.com"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          defaultValue={state?.value}
          aria-invalid={state ? !state.ok : undefined}
          aria-describedby={state ? "add-admin-result" : undefined}
          required
        />
        {firstAdmin ? (
          // The first name on the list replaces the owner-workspace fallback, so say so before it happens.
          <ConfirmSubmit question="Only accounts on the list will be admins, so add yourself too to keep access." confirmLabel="Add admin" pending={pending} size="md">
            Add admin
          </ConfirmSubmit>
        ) : (
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Adding…" : "Add admin"}
          </Button>
        )}
      </div>
      {state && (
        <p id="add-admin-result" role={state.ok ? "status" : "alert"} className={state.ok ? "text-sm text-muted" : "text-sm text-bad"}>
          {state.message}
        </p>
      )}
    </form>
  );
}
