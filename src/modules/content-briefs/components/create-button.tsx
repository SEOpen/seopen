"use client";

import { useFormStatus } from "react-dom";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { costLabel } from "@/modules/keywords/format";
import { rules } from "@/plan-policy/rules";

/** Create brief, with its price on it. A new top 10 takes about a minute and reading the top 3 pages a few seconds more, so it says so while it works. */
export function CreateBriefButton({ credits, disabled, title }: { credits: number; disabled?: boolean; title?: string }) {
  const { pending } = useFormStatus();
  const price = credits ? costLabel(credits * rules.creditUsd) : "saved lookups, free";
  return (
    <SpendConfirm first question="" pending={pending} disabled={disabled} title={title}>
      {pending ? "Creating the brief…" : `Create brief (${price})`}
    </SpendConfirm>
  );
}
