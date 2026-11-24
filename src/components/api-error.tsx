import { UpgradeNow } from "@/components/plan-upgrade";
import { Callout } from "@/components/ui/callout";
import { RetryButton } from "@/components/ui/retry-button";
import { isInternal } from "@/lib/billing/gates";
import { refusalTitle } from "@/lib/billing/refusal-title";
import { BudgetExceededError, DataForSEOError, SpendRefusedError } from "@/lib/dataforseo/client";
import { plainFailure } from "@/lib/dataforseo/failure-copy";
import { currentWorkspace } from "@/lib/workspace/current";

/**
 * Renders a failed data load as a callout instead of crashing the page. A refusal is written for
 * the customer and shows as it is. Any other failure shows in plain words, with Retry when trying
 * again could work (it never spends without showing the price again, see RetryButton), and the raw
 * text goes to the server logs; the internal workspace sees it here too.
 */
export async function ApiError({ error }: { error: unknown }) {
  if (error instanceof SpendRefusedError) {
    return (
      <Callout tone="warn" title={refusalTitle(error.code)}>
        {error.message}
        {error.upgradable && <UpgradeNow size="sm" className="mt-3" />}
      </Callout>
    );
  }
  // A bare BudgetExceededError (dollars, DataForSEO) only reaches the internal workspace.
  if (error instanceof BudgetExceededError) {
    return (
      <Callout tone="warn" title="Monthly API cap reached">
        {error.message}
      </Callout>
    );
  }
  const raw = error instanceof Error ? error.message : String(error);
  console.error("[api-error]", error instanceof DataForSEOError ? `${error.statusCode} ${error.endpoint}: ${raw}` : raw);
  const failure = plainFailure(error);
  // Never let the lookup behind this choice take the error display down with it.
  const internal = await currentWorkspace().then(isInternal, () => false);
  return (
    <Callout tone="bad" title={failure.title}>
      {internal ? raw : failure.message}
      {failure.retry && (
        <div className="mt-2">
          <RetryButton />
        </div>
      )}
    </Callout>
  );
}
