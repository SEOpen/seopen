"use client";

import { useFormStatus } from "react-dom";
import { SpendConfirm } from "@/components/ui/spend-confirm";

/**
 * Refresh always spends, and the page already has numbers on it, so it asks first. Goes inside the form that runs it.
 * `refused`: why the workspace can't spend. The banner says it too, so the button is just off.
 */
export function RefreshButton({ cost, target, refused }: { cost: string; target: string; refused?: string | null }) {
  const { pending } = useFormStatus();
  return (
    <SpendConfirm pending={pending} disabled={!!refused} question={`Fetch fresh numbers for ${target} (${cost})?`} confirmLabel="Refresh" title={refused ?? "Bypass the saved data and fetch fresh numbers"}>
      {pending ? "Refreshing…" : `Refresh (${cost})`}
    </SpendConfirm>
  );
}
