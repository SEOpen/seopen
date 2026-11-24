"use client";

import { useActionState } from "react";
import { setFirstPassword, type SetPasswordState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label } from "@/components/ui/input";

/** The first password after a confirmation link (/set-password). `next` is where the person goes once it's saved. */
export function SetPasswordForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<SetPasswordState, FormData>(setFirstPassword, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      {state?.error && <Callout tone="bad" role="alert" title={state.error} />}
      <input type="hidden" name="next" value={next} />
      <Label>
        Password (8 characters or more)
        <Input type="password" name="password" autoComplete="new-password" required minLength={8} autoFocus />
      </Label>
      <Label>
        Repeat it
        <Input type="password" name="confirm" autoComplete="new-password" required minLength={8} />
      </Label>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
