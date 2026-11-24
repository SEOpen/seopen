"use client";

import { useActionState } from "react";
import { Callout } from "@/components/ui/callout";
import { HeaderMessage } from "@/components/ui/header-message";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { formatUsd } from "@/lib/format";
import { checkNow, type ActionState } from "../actions";

const keywordCount = (n: number) => `${n} keyword${n === 1 ? "" : "s"}`;

/**
 * "Check now" and "Deep check" in one form, so a pending submit disables both. With no results yet,
 * Check now is what the page is for and runs on one click; after that both ask first. The server
 * refuses a second run while one is in flight and says so here. The costs are upper bounds, every
 * keyword rechecked twice; a null cost hides them (plan-covered checks outside the owner's workspace).
 * `refused`: why the plan or the workspace won't run a check. Both buttons are off, with it as their title.
 */
export function CheckNowForm({
  projectId,
  keywords,
  dailyDepth,
  sweepDepth,
  quickUsd,
  deepUsd,
  busy,
  hasResults,
  refused,
}: {
  projectId: number;
  keywords: number;
  dailyDepth: number;
  sweepDepth: number;
  quickUsd: number | null;
  deepUsd: number | null;
  busy: boolean;
  hasResults: boolean;
  refused?: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(checkNow.bind(null, projectId), {});
  const upTo = (usd: number | null) => (usd == null ? "" : ` (up to ${formatUsd(usd, 3)})`);
  const costing = (usd: number | null) => (usd == null ? "" : `, up to ${formatUsd(usd, 3)}`);
  const again = "Keywords that come back missing or far lower are looked up to twice more, so most checks cost less than this.";
  return (
    <form action={action}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SpendConfirm
          name="mode"
          value="deep"
          disabled={busy || !!refused}
          pending={pending}
          confirmLabel="Run deep check"
          question={`Look up ${keywordCount(keywords)} in the top ${sweepDepth} results, with Google's AI answers${costing(deepUsd)}?`}
          title={refused ?? `Look up ${keywordCount(keywords)} now in the top ${sweepDepth} results, with Google's AI answers. ${again}`}
        >
          Deep check{upTo(deepUsd)}
        </SpendConfirm>
        <SpendConfirm
          name="mode"
          value="quick"
          first={!hasResults}
          disabled={busy || !!refused}
          pending={pending}
          confirmLabel="Run check"
          question={`Look up ${keywordCount(keywords)} in the top ${dailyDepth} results${costing(quickUsd)}?`}
          title={refused ?? `Look up ${keywordCount(keywords)} now in the top ${dailyDepth} results. ${again}`}
        >
          {pending ? "Starting…" : "Check now"}
          {!pending && upTo(quickUsd)}
        </SpendConfirm>
      </div>
      {state.error && (
        <HeaderMessage>
          <Callout role="alert" tone="warn">
            {state.error}
          </Callout>
        </HeaderMessage>
      )}
    </form>
  );
}
