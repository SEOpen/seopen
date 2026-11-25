"use client";

import { useActionState } from "react";
import { Callout } from "@/components/ui/callout";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { authClient } from "@/lib/auth/client";

type State = { error: string } | { done: "browsers" | "everything" } | null;

/** Ends the account's other sessions (src/lib/auth/sign-out-elsewhere-plugin.ts). This browser gets a new one in the answer. */
async function signOutElsewhere(_prev: State, form: FormData): Promise<State> {
  const agents = form.get("agents") === "on";
  const { error } = await authClient.$fetch("/sign-out-elsewhere", { method: "POST", body: { agents } });
  if (!error) return { done: agents ? "everything" : "browsers" };
  if (error.status === 401) return { error: "You've been signed out. Sign in and try again." };
  if (error.status === 429) return { error: "Too many tries. Wait a few minutes and try again." };
  return { error: "That couldn't be confirmed. Sign in again and try once more." };
}

export function SignOutElsewhereForm() {
  const [state, action, pending] = useActionState<State, FormData>(signOutElsewhere, null);
  return (
    <form action={action} className="flex flex-col items-start gap-4">
      {state && "done" in state && (
        <Callout role="status" title="Signed out everywhere else">
          {state.done === "everything"
            ? "Every other browser was signed out, and your API keys and connected apps were disconnected."
            : "Every other browser was signed out. Your API keys and connected apps still work."}
        </Callout>
      )}
      {state && "error" in state && <Callout tone="bad" role="alert" title={state.error} />}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="agents" defaultChecked className="mt-1" />
        <span>
          Also cut off API keys and connected apps
          <span className="block text-xs text-muted">
            Revokes the API keys you made and disconnects your connected apps, in every workspace. Leave it ticked if someone else may have been in your account: they could
            have made one.
          </span>
        </span>
      </label>
      <ConfirmSubmit question="Sign out every other browser?" confirmLabel="Sign out" variant="danger" size="md" pending={pending}>
        {pending ? "Signing out…" : "Sign out everywhere else"}
      </ConfirmSubmit>
    </form>
  );
}
