"use client";

import { useActionState, useId, useState } from "react";
import type { AdminDeleteState } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/** Permanently deletes a workspace or an account from Admin. The button stays off until "delete" is typed. */
export function AdminDeleteForm({ action, name, value, label }: { action: (prev: AdminDeleteState, formData: FormData) => Promise<AdminDeleteState>; name: string; value: string | number; label: string }) {
  const [state, formAction, pending] = useActionState<AdminDeleteState, FormData>(action, null);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  return (
    <form action={formAction} className="flex flex-col items-start gap-2">
      <input type="hidden" name={name} value={value} />
      <Label htmlFor={inputId}>
        <span>
          Type <b className="font-medium">delete</b> to confirm
        </span>
      </Label>
      <Input id={inputId} name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} className="w-full max-w-80" />
      <Button type="submit" variant="danger" disabled={pending || typed.trim().toLowerCase() !== "delete"}>
        {pending ? "Deleting…" : label}
      </Button>
      {state?.error && (
        <p role="alert" className="text-xs text-bad">
          {state.error}
        </p>
      )}
    </form>
  );
}
