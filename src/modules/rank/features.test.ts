import { describe, expect, it } from "vitest";
import { featureLabel } from "./features";

describe("featureLabel", () => {
  it("spells out People also ask", () => {
    expect(featureLabel("people_also_ask")).toBe("People also ask");
  });

  it("cleans up a type it doesn't know", () => {
    expect(featureLabel("some_new_feature")).toBe("Some new feature");
  });
});
