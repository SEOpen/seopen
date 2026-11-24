"use client";

import { useActionState, useId, useState } from "react";
import { deleteWorkspace, type DeleteWorkspaceState } from "@/app/actions/settings";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/** Permanently deletes the current workspace. The button stays off until "delete" is typed. */
export function DeleteWorkspace() {
  const [state, action, pending] = useActionState<DeleteWorkspaceState, FormData>(deleteWorkspace, null);
  const [typed, setTyped] = useState("");
  const inputId = useId();
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <Label htmlFor={inputId}>
        <span>
          Type <b className="font-medium">delete</b> to confirm
        </span>
      </Label>
      <Input id={inputId} name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} className="w-full" />
      <Button type="submit" variant="danger" disabled={pending || typed.trim().toLowerCase() !== "delete"}>
        {pending ? "Deleting…" : "Delete workspace"}
      </Button>
      {state?.error && (
        <p role="status" className="text-xs text-bad">
          {state.error}
        </p>
      )}
    </form>
  );
}
