"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";

export function SignInForm({ next, google }: { next: string; google: boolean }) {
  const [error, setError] = useState<{ title: string; unverified?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    setPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({ email, password: String(form.get("password")), callbackURL: next });
    setPending(false);
    // Signing in to connect an app: Better Auth's client is already following the provider's redirect.
    if (!error && data && "url" in data && data.redirect) return;
    if (!error) return window.location.assign(next);
    if (error.code === "EMAIL_NOT_VERIFIED") setError({ title: "Confirm your email first. Check your inbox for the link.", unverified: email });
    else if (error.status === 429) setError({ title: "Too many tries. Wait a few minutes and try again." });
    else setError({ title: "Wrong email or password." });
  }

  async function resend(email: string) {
    await authClient.sendVerificationEmail({ email, callbackURL: next });
    setResent(true);
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error && (
          <Callout tone="bad" title={error.title} role="alert">
            {error.unverified &&
              (resent ? (
                "Sent. The new link expires in 24 hours."
              ) : (
                <button type="button" className="underline" onClick={() => resend(error.unverified!)}>
                  Send the link again
                </button>
              ))}
          </Callout>
        )}
        <Label>
          Email
          <Input type="email" name="email" autoComplete="email" required autoFocus />
        </Label>
        <Label>
          Password
          <Input type="password" name="password" autoComplete="current-password" required minLength={8} />
        </Label>
        <Button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      {google && (
        <Button type="button" variant="secondary" onClick={() => authClient.signIn.social({ provider: "google", callbackURL: next, errorCallbackURL: "/sign-in" })}>
          Sign in with Google
        </Button>
      )}
      <Link href="/forgot-password" className="text-center text-sm text-muted underline">
        Forgot your password?
      </Link>
    </div>
  );
}
