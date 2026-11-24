"use client";

import { useActionState, type ReactNode } from "react";
import { UpgradeNow } from "@/components/plan-upgrade";
import { RefusalText } from "@/components/ui/refusal-text";
import type { ActionRefusal, ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/utils";

/** Why an action said no, in place, with Upgrade now when that would help. Sits outside any form, since Upgrade now is its own form. */
export function ActionProblem({ result, align = "start" }: { result: ActionRefusal | null; align?: "start" | "end" }) {
  if (!result) return null;
  return (
    <div role="alert" className={cn("flex flex-col gap-2 text-xs text-bad", align === "end" && "max-w-72 items-end text-right")}>
      <p className="[overflow-wrap:anywhere]">
        <RefusalText text={result.error} />
      </p>
      {result.upgradable && <UpgradeNow size="sm" />}
    </div>
  );
}

/**
 * A form whose Server Action can refuse. The action returns `{ error }` and the reason shows right
 * under the form, leaving the page as it is. Anything the action throws is a real failure and goes
 * to the page's error.tsx. `align="end"` is for a form at the right of a row or header.
 */
export function ActionForm({
  action,
  children,
  className,
  id,
  align = "start",
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  /** For controls elsewhere on the page that join this form with their `form` attribute. */
  id?: string;
  align?: "start" | "end";
}) {
  const [result, formAction] = useActionState(async (_prev: ActionRefusal | null, formData: FormData) => (await action(formData)) ?? null, null);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", align === "end" && "items-end")}>
      <form id={id} action={formAction} className={className}>
        {children}
      </form>
      <ActionProblem result={result} align={align} />
    </div>
  );
}
