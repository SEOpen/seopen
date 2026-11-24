import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefusalText } from "./refusal-text";
import { rules } from "@/plan-policy/rules";

describe("RefusalText", () => {
  it.skipIf(!rules.hasPlans)("makes the Billing page a link where a refusal names it", () => {
    const html = renderToStaticMarkup(<RefusalText text="Your plan doesn't include keywords. Choose a plan on the Billing page to add them." />);
    expect(html).toBe('Your plan doesn&#x27;t include keywords. Choose a plan on <a class="underline" href="/billing">the Billing page</a> to add them.');
  });

  it("leaves any other refusal as it is", () => {
    expect(renderToStaticMarkup(<RefusalText text="Your plan allows 100 keywords; 3 more fit." />)).toBe("Your plan allows 100 keywords; 3 more fit.");
  });
});
