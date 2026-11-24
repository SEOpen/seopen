import { SpendConfirm } from "@/components/ui/spend-confirm";
import { LIGHTHOUSE_PRICE_USD, priceText } from "../transform";

/** Run Lighthouse, inside the form that runs it. `refused`: why the workspace can't spend. The banner says it too, so the button is just off. */
export function LighthouseButton({ queued, showCost, refused }: { queued: boolean; showCost: boolean; refused?: string | null }) {
  const price = priceText(LIGHTHOUSE_PRICE_USD);
  return (
    <SpendConfirm disabled={queued || !!refused} title={refused ?? undefined} confirmLabel="Run" question={`Run Lighthouse on the homepage${showCost ? `, about ${price}` : ""}?`}>
      {showCost ? `Run Lighthouse (≈ ${price})` : "Run Lighthouse"}
    </SpendConfirm>
  );
}
