import { describe, expect, it } from "vitest";
import { filterQuery } from "./filter-bar";

describe("filterQuery", () => {
  it("keeps what's filled in, under the same param names", () => {
    expect(filterQuery([["range", "30"], ["bucket", ""], ["change", "improved"]])).toBe("range=30&change=improved");
  });

  it("never carries run, which spends on GET", () => {
    expect(filterQuery([["q", "x.com"], ["run", "1"]])).toBe("q=x.com");
  });

  it("is empty when nothing is picked", () => {
    expect(filterQuery([["bucket", ""]])).toBe("");
  });
});
