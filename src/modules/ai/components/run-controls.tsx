"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { UpgradeNow } from "@/components/plan-upgrade";
import { Callout } from "@/components/ui/callout";
import { HeaderMessage } from "@/components/ui/header-message";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { formatUsd } from "@/lib/format";
import { rules } from "@/plan-policy/rules";
import { costLabel } from "@/modules/keywords/format";
import { runNow } from "../actions";
import { roundUsd } from "../prompts";

/** What a run by hand spends, after the question it asks. */
const RUN_COST = (cost: string) =>
  rules.hasPlans ? `It uses research credits (${cost}); Monday's run comes with your plan.` : `It costs ${cost} of DataForSEO; Monday's run still asks every prompt.`;

/**
 * "Run now". With no answers to show yet (`first`) it's what the page is for and runs on one click;
 * after that it's secondary and asks once, in place, before spending. A run started by hand uses
 * research credits, so it shows their price, and the dollars too where `estimateUsd` isn't
 * null (the owner's workspace). `refused`: why the plan or the workspace won't run one, so it's off
 * with that as its title.
 */
export function RunButton({
  projectId,
  estimateUsd,
  credits,
  answers,
  disabled,
  refused,
  first = false,
}: {
  projectId: number;
  estimateUsd: number | null;
  /** The run's price in research credits, from `creditsFor`: all a customer's browser is told. */
  credits: number;
  answers: number;
  disabled?: boolean;
  refused?: string | null;
  first?: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string; upgradable?: boolean } | null>(null);
  const price = costLabel(credits * rules.creditUsd);
  // Without plans the price is in dollars already, so it isn't said twice.
  const cost = estimateUsd == null || !rules.hasPlans ? price : `${price} · ${formatUsd(roundUsd(estimateUsd))}`;
  const label = answers === 0 ? "Run now" : `Run now (${cost})`;
  return (
    <>
      <form action={() => start(async () => setResult(await runNow(projectId)))}>
        <SpendConfirm
          first={first}
          disabled={disabled || !!refused || answers === 0}
          title={refused ?? undefined}
          pending={pending}
          confirmLabel="Run now"
          question={`Ask ${answers} ${answers === 1 ? "question" : "questions"} now, one per prompt on each platform? ${RUN_COST(cost)}`}
        >
          {pending ? "Queuing…" : label}
        </SpendConfirm>
      </form>
      {result && (
        <HeaderMessage>
          <Callout role={result.ok ? "status" : "alert"} tone={result.ok ? "info" : "warn"}>
            {result.message}
            {/* Its own form, so it sits outside the one above. */}
            {result.upgradable && <UpgradeNow size="sm" className="mt-2" />}
          </Callout>
        </HeaderMessage>
      )}
    </>
  );
}

/** Refreshes the page every few seconds while a run is in progress. */
export function AutoRefresh({ active, everyMs = 5000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return null;
}
