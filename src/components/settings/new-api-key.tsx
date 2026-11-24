"use client";

import Link from "next/link";
import { type Ref, useActionState, useEffect, useRef, useState } from "react";
import { createApiKeyAction, type CreateKeyState } from "@/app/actions/api-keys";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { rules } from "@/plan-policy/rules";
import { connectSnippets, exportKeyLine } from "./connect-snippets";

/** Makes a key and shows it once, with how to connect Claude Code, Cursor and Codex. */
export function NewApiKey({ endpoint, free = false }: { endpoint: string; free?: boolean }) {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createApiKeyAction, null);
  return <NewApiKeyForm state={state} action={action} pending={pending} endpoint={endpoint} free={free} />;
}

/**
 * The form and what it returned. A new key goes above the form, which has emptied itself, and the page
 * moves to it: the table above grows by a row, so the key would otherwise land out of sight. `free`: the
 * Free plan has no research credits, so it isn't offered a key that spends them.
 */
export function NewApiKeyForm({
  state,
  action,
  pending,
  endpoint,
  free = false,
}: {
  state: CreateKeyState;
  action: (formData: FormData) => void;
  pending: boolean;
  endpoint: string;
  free?: boolean;
}) {
  const made = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state?.ok || !made.current) return;
    made.current.scrollIntoView({ block: "start" });
    made.current.focus({ preventScroll: true });
  }, [state]);

  return (
    <div className="flex flex-col gap-3">
      {state?.ok && <NewKeyResult ref={made} name={state.name} secret={state.key} endpoint={endpoint} />}
      <form action={action} className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <Label className="min-w-0 flex-1">
            Name
            <Input name="name" required maxLength={80} placeholder="Claude Code on my laptop" />
          </Label>
          <Button type="submit" disabled={pending}>
            {pending ? "Making…" : "Make key"}
          </Button>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="write" className="mt-1" />
          <span>
            Can make changes
            <span className="block text-xs text-muted">
              {free ? (
                <>
                  Create a project, start the weekly site audit, and record fixes. Each change is described to the agent first and made only when it confirms. Nothing can be
                  deleted.
                </>
              ) : (
                <>
                  Create projects, add keywords, prompts and Local SEO listings, start checks, and record fixes. Each change is described to the agent first and made only when it
                  confirms. Nothing can be deleted. {rules.hasPlans ? "Checks count against your plan." : "Checks count against the workspace's monthly DataForSEO cap."} {rules.hasPlans ? `Steps that use ${rules.researchNoun}` : "Research steps"}, such as Local SEO, also need {rules.researchScope}.
                </>
              )}
            </span>
          </span>
        </label>
        {free ? (
          <p className="text-xs text-muted">
            Research credits come with Starter, so a key on Free can&apos;t buy keyword, domain or backlink lookups.{" "}
            {rules.plansHref && (
              <Link href={rules.plansHref} className="text-accent underline-offset-3 hover:underline">
                See plans
              </Link>
            )}
          </p>
        ) : (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="research" className="mt-1" />
            <span>
              {rules.researchScope}
              <span className="block text-xs text-muted">Run keyword, domain and backlink lookups. Each call has to name the most it may spend, and the agent is told to show you the price and ask first. Without this, a key can still read lookups you&apos;ve already paid for.</span>
            </span>
          </label>
        )}
      </form>
      {state && !state.ok && (
        <p role="alert" className="text-xs text-bad">
          {state.message}
        </p>
      )}
    </div>
  );
}

/**
 * The new key, shown once, then how to connect an agent: the key goes in `SEOPEN_API_KEY`, and each
 * agent's config reads it from there (`connect-snippets.ts`).
 */
export function NewKeyResult({ name, secret, endpoint, ref }: { name: string; secret: string; endpoint: string; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} tabIndex={-1} role="status" className="flex scroll-mt-16 flex-col gap-3 rounded-md bg-surface-2 p-3 text-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <p>
        <span className="font-medium">{name}</span>: copy this key now. It won&apos;t be shown again.
      </p>
      <CopyLine code={secret} truncate />
      <p className="text-xs text-secondary">
        1. Put it in your environment, for example in <code className="font-mono">~/.zshrc</code>, then open a new terminal:
      </p>
      <CopyLine code={exportKeyLine(secret)} />
      <p className="text-xs text-secondary">2. Connect your agent. Each one reads the key from that variable, so it isn&apos;t written into the agent&apos;s settings.</p>
      {connectSnippets(endpoint).map((s) => (
        <div key={s.id} className="flex flex-col gap-1">
          <p className="text-xs text-muted">
            {s.label}
            {s.where ? (
              <>
                , in <code className="font-mono">{s.where}</code>:
              </>
            ) : (
              ", in a terminal:"
            )}
          </p>
          <CopyLine code={s.code} />
        </div>
      ))}
    </div>
  );
}

/** A line or block of code with a button that copies it. */
function CopyLine({ code, truncate = false }: { code: string; truncate?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <code className={truncate ? "min-w-0 flex-1 truncate rounded-sm bg-surface px-2 py-1 font-mono text-xs" : "min-w-0 flex-1 rounded-sm bg-surface px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap"}>{code}</code>
      <Button type="button" size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
