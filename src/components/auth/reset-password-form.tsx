"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";

/** `first` is a beta invite choosing the account's first password. */
export function ResetPasswordForm({ token, first = false }: { token: string; first?: boolean }) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "mismatch" | "failed">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("password"));
    if (newPassword !== String(form.get("confirm"))) return setState("mismatch");
    setState("pending");
    const { error } = await authClient.resetPassword({ newPassword, token });
    setState(error ? "failed" : "done");
  }

  if (state === "done")
    return (
      <Callout title={first ? "Password set" : "Password changed"}>
        {first ? "Your account is ready." : "Every other session was signed out, and your API keys and connected apps were disconnected."}{" "}
        <Link className="underline" href="/sign-in">
          Sign in
        </Link>
      </Callout>
    );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {state === "mismatch" && <Callout tone="bad" role="alert" title="The two passwords don't match." />}
      {state === "failed" && (
        <Callout tone="bad" role="alert" title="That link has expired or was already used.">
          <Link className="underline" href="/forgot-password">
            Get a new link
          </Link>
        </Callout>
      )}
      <Label>
        {first ? "Password" : "New password"} (8 characters or more)
        <Input type="password" name="password" autoComplete="new-password" required minLength={8} autoFocus />
      </Label>
      <Label>
        Repeat it
        <Input type="password" name="confirm" autoComplete="new-password" required minLength={8} />
      </Label>
      <Button type="submit" disabled={state === "pending"}>
        {state === "pending" ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
