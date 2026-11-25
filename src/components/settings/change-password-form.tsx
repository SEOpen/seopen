"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";

const ERRORS = {
  mismatch: "The two passwords don't match.",
  wrong: "That's not your current password.",
  long: "That password is too long. Use 128 characters or fewer.",
  limited: "Too many tries. Wait a few minutes and try again.",
  signedOut: "You've been signed out. Sign in and try again.",
  failed: "The password change couldn't be confirmed. Sign in again to check which password works.",
};

type State = "idle" | "pending" | "done" | keyof typeof ERRORS;

/**
 * A new password for the account that's signed in. The server signs out every other session and
 * cuts off agents (src/lib/auth/index.ts), and gives this browser a new session.
 */
export function ChangePasswordForm({ email }: { email: string }) {
  const [state, setState] = useState<State>("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const form = new FormData(el);
    const newPassword = String(form.get("password"));
    if (newPassword !== String(form.get("confirm"))) return setState("mismatch");
    setState("pending");
    const { error } = await authClient.changePassword({ currentPassword: String(form.get("current")), newPassword, revokeOtherSessions: true });
    if (!error) {
      el.reset();
      return setState("done");
    }
    if (error.code === "INVALID_PASSWORD") setState("wrong");
    else if (error.code === "PASSWORD_TOO_LONG") setState("long");
    else if (error.status === 429) setState("limited");
    else if (error.status === 401) setState("signedOut");
    else setState("failed");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {state === "done" && (
        <Callout role="status" title="Password changed">
          Every other browser was signed out, and your API keys and connected apps were disconnected.
        </Callout>
      )}
      {state in ERRORS && <Callout tone="bad" role="alert" title={ERRORS[state as keyof typeof ERRORS]} />}
      {/* So a password manager saves the new password against the right account. */}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <Label>
        Current password
        <Input type="password" name="current" autoComplete="current-password" required />
      </Label>
      <Label>
        New password (8 characters or more)
        <Input type="password" name="password" autoComplete="new-password" required minLength={8} />
      </Label>
      <Label>
        Repeat it
        <Input type="password" name="confirm" autoComplete="new-password" required minLength={8} />
      </Label>
      <Button type="submit" className="self-start" disabled={state === "pending"}>
        {state === "pending" ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
