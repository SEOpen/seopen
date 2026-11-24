"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { authClient } from "@/lib/auth/client";
import { rules } from "@/plan-policy/rules";

/**
 * The scopes an Allow grants: reading, when the app asked for it, the boxes ticked among those it
 * asked for, and a refresh token when it asked for one. Never a scope the app didn't ask for: the
 * provider refuses that consent, and the page would say the request had expired.
 */
export function grantedScopes(asked: string[], ticked: (scope: "write" | "research") => boolean): string[] {
  return [
    ...(asked.includes("read") ? ["read"] : []),
    ...(["write", "research"] as const).filter((s) => asked.includes(s) && ticked(s)),
    ...(asked.includes("offline_access") ? ["offline_access"] : []),
  ];
}

/**
 * Allow or Cancel on the consent page, with the API key form's two boxes. Reading is always
 * included; a box shows only when the app asked for that scope, and starts unticked. An app that
 * didn't ask to read gets only Cancel and a word on why: the MCP endpoint refuses every token
 * without reading, so allowing it would connect nothing. The answer goes to `/oauth2/consent` with
 * the page's signed query (oauthProviderClient adds it), and Better Auth's client follows the
 * redirect back to the app.
 */
export function ConnectForm({ scopes }: { scopes: string[] }) {
  const [pending, setPending] = useState<"allow" | "cancel" | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function answer(accept: boolean, form?: HTMLFormElement) {
    setPending(accept ? "allow" : "cancel");
    setError(null);
    const data = form ? new FormData(form) : null;
    const granted = grantedScopes(scopes, (s) => data?.get(s) === "on");
    const { error } = await authClient.$fetch<{ redirect: boolean; url: string }>("/oauth2/consent", {
      method: "POST",
      body: accept ? { accept, scope: granted.join(" ") } : { accept },
    });
    setPending(null);
    if (error) return setError(error.status === 400 || error.status === 401 ? "This request has expired. Go back to the app and connect SEOpen again." : "That didn't work. Try again.");
    setDone(true);
  }

  if (done) return <Callout role="status" title="Done. Your browser is going back to the app.">You can close this tab if it stays open.</Callout>;

  const cancel = (
    <Button type="button" variant="secondary" disabled={pending != null} onClick={() => void answer(false)}>
      {pending === "cancel" ? "Cancelling…" : "Cancel"}
    </Button>
  );

  if (!scopes.includes("read")) {
    return (
      <div className="flex flex-col gap-4">
        {error && <Callout tone="bad" role="alert" title={error} />}
        <Callout tone="warn" title="This app didn't ask to read your workspace.">
          Every SEOpen tool needs reading, so there&apos;s nothing to allow. Cancel, then connect SEOpen again from the app, or ask its maker to request the read scope.
        </Callout>
        <div className="flex gap-2">{cancel}</div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void answer(true, e.currentTarget);
      }}
    >
      {error && <Callout tone="bad" role="alert" title={error} />}
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Read every project in the workspace
          <span className="block text-xs text-muted">Rankings, audits, AI visibility, Local SEO and lookups you&apos;ve already paid for. Reading costs nothing.</span>
        </p>
        {scopes.includes("write") && (
          <label className="flex items-start gap-2">
            <input type="checkbox" name="write" className="mt-1" />
            <span>
              Can make changes
              <span className="block text-xs text-muted">
                Create projects, add keywords, prompts and Local SEO listings, start checks, and record fixes. Each change is described to the agent first and made only when it
                confirms. Nothing can be deleted. {rules.hasPlans ? "Checks count against your plan." : "Checks count against the workspace's monthly DataForSEO cap."} {rules.hasPlans ? `Steps that use ${rules.researchNoun}` : "Research steps"}, such as Local SEO, also need {rules.researchScope}.
              </span>
            </span>
          </label>
        )}
        {scopes.includes("research") && (
          <label className="flex items-start gap-2">
            <input type="checkbox" name="research" className="mt-1" />
            <span>
              {rules.researchScope}
              <span className="block text-xs text-muted">
                Run keyword, domain and backlink lookups. Each call has to name the most it may spend, and the agent is told to show you the price and ask first.
              </span>
            </span>
          </label>
        )}
        {scopes.includes("offline_access") && (
          <p className="text-xs text-muted">It stays connected until you disconnect it on the MCP page, or after 30 days without use.</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending != null}>
          {pending === "allow" ? "Allowing…" : "Allow"}
        </Button>
        {cancel}
      </div>
    </form>
  );
}
