"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";

export function ForgotPasswordForm() {
  const [state, setState] = useState<"idle" | "pending" | "sent" | "limited">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("pending");
    const email = String(new FormData(e.currentTarget).get("email"));
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    // Same answer whether or not the address has an account, so the form can't be used to probe.
    setState(error?.status === 429 ? "limited" : "sent");
  }

  if (state === "sent")
    return <Callout title="Check your inbox">If that address has a SEOpen account, a reset link is on its way. It expires in 1 hour.</Callout>;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {state === "limited" && <Callout tone="bad" role="alert" title="Too many requests. Wait a few minutes and try again." />}
      <Label>
        Email
        <Input type="email" name="email" autoComplete="email" required autoFocus />
      </Label>
      <Button type="submit" disabled={state === "pending"}>
        {state === "pending" ? "Sending…" : "Email me a reset link"}
      </Button>
    </form>
  );
}
