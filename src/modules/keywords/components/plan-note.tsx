import { ButtonLink } from "@/components/ui/button";
import { PlanFeature } from "@/components/ui/plan-feature";
import { href } from "../market";

/**
 * Free has no research credits, so a keyword research page says what Starter adds instead of offering a
 * lookup it would refuse. Saved lists cost nothing, so with some saved they stay a way forward.
 */
export function KeywordsPlanFeature({ hasLists, locationCode }: { hasLists: boolean; locationCode: number }) {
  return (
    <PlanFeature
      module="keywords"
      extra={
        hasLists ? (
          <ButtonLink href={href("/keywords/lists", { loc: locationCode })} variant="secondary">
            Open saved lists
          </ButtonLink>
        ) : undefined
      }
    />
  );
}
