"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import type { FirstVisit } from "@/lib/first-visit";
import { FIRST_VISIT_PARAMS } from "@/lib/first-visit-capture";
import { TURNSTILE_HEADER } from "@/lib/turnstile";
import { Turnstile } from "./turnstile";

/**
 * Public sign-up (src/lib/signup.ts). Better Auth answers an address that already has an account
 * the same way as a new one, and so does this form, so it can't be used to find out who has one.
 * The inbox itself gets the reason by email.
 *
 * `firstVisit` is where the visit to the site came from, when its sign-up link carried it. It goes
 * with the email sign-up, or into Better Auth's OAuth state for Google, and the new account keeps it
 * (src/lib/first-visit.ts).
 *
 * With `turnstileSiteKey`, the email sign-up waits for Cloudflare Turnstile's token and sends it in
 * a header the auth route checks (src/lib/turnstile.ts). Without one (local dev) it sends none.
 */
export function SignUpForm({ google, firstVisit, turnstileSiteKey }: { google: boolean; firstVisit: FirstVisit; turnstileSiteKey: string | null }) {
  const [state, setState] = useState<"idle" | "pending" | "limited" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const waiting = !!turnstileSiteKey && !token;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email")).trim();
    setState("pending");
    setError(null);
    // Better Auth's client sends the whole body, but its type lists only its own fields, so the
    // visit rides in a body built first. The server ignores a key it doesn't know.
    const body = { email, password: String(form.get("password")), name: "", callbackURL: "/", firstVisit };
    const headers: Record<string, string> = token ? { [TURNSTILE_HEADER]: token } : {};
    const { error } = await authClient.signUp.email({ ...body, fetchOptions: { headers } });
    if (!error) {
      setSentTo(email);
      return setState("idle");
    }
    // The token is spent either way, so a second try needs a new one.
    if (turnstileSiteKey) setResetKey((n) => n + 1);
    if (error.status === 429) return setState("limited");
    setState("failed");
    // Better Auth's messages for a throwaway inbox, a bad address or a short password are written for
    // people, and so are the Turnstile check's (403, 503).
    setError([400, 403, 503].includes(error.status) && error.message ? error.message : null);
  }

  if (sentTo)
    return (
      <Callout title="Check your inbox">
        If {sentTo} can take a new account, a confirmation link is on its way. It expires in 24 hours. Open it, choose your password, and you&apos;re in your new workspace. Nothing there? Check spam, or sign in if this inbox already has an account.
      </Callout>
    );

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {state === "limited" && <Callout tone="bad" role="alert" title="Too many tries. Wait a few minutes and try again." />}
        {state === "failed" && <Callout tone="bad" role="alert" title={error ?? "That didn't work. Try again in a moment."} />}
        <Label>
          Email
          <Input type="email" name="email" autoComplete="email" required autoFocus />
        </Label>
        <Label>
          Password (8 characters or more)
          <Input type="password" name="password" autoComplete="new-password" required minLength={8} />
        </Label>
        {turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} onToken={setToken} resetKey={resetKey} />}
        <Button type="submit" disabled={state === "pending" || waiting}>
          {state === "pending" ? "Creating your account…" : waiting ? "Checking your browser…" : "Create account"}
        </Button>
      </form>
      {google && (
        <Button type="button" variant="secondary" onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: errorPage(firstVisit), additionalData: { firstVisit } })}>
          Sign up with Google
        </Button>
      )}
    </div>
  );
}

/** Where a refused Google sign-up comes back to: this page, still carrying the visit, so a second try keeps it. */
function errorPage(visit: FirstVisit): string {
  const query = new URLSearchParams();
  if (visit.source) query.set(FIRST_VISIT_PARAMS.source, visit.source);
  if (visit.referrerHost) query.set(FIRST_VISIT_PARAMS.referrerHost, visit.referrerHost);
  if (visit.landingPath) query.set(FIRST_VISIT_PARAMS.landingPath, visit.landingPath);
  return query.size ? `/sign-up?${query}` : "/sign-up";
}
