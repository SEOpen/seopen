import { describe, expect, it } from "vitest";
import { searchesIn, sourceLabel } from "./format";

describe("sourceLabel", () => {
  it("renders keyword-idea sources", () => {
    expect(sourceLabel("ideas:suggestions:landscape design")).toBe("Keyword ideas · suggestions for “landscape design”");
    expect(sourceLabel("ideas:related:a: b")).toBe("Keyword ideas · related searches for “a: b”");
    expect(sourceLabel("ideas:questions:")).toBe("Keyword ideas · questions");
  });

  it("renders domain and gap sources", () => {
    expect(sourceLabel("domain:example.com")).toBe("Domain keywords · example.com");
    expect(sourceLabel("gap:a.com,b.com,c.com")).toBe("Keyword gap · a.com vs b.com vs c.com");
  });

  it("passes through free text and empties", () => {
    expect(sourceLabel("keyword overview")).toBe("Keyword overview");
    expect(sourceLabel("something else")).toBe("something else");
    expect(sourceLabel(null)).toBeNull();
    expect(sourceLabel("  ")).toBeNull();
  });
});

describe("searchesIn", () => {
  // Research volumes are the country's, from Labs; a tracked keyword's are its city's, from Google Ads. Each says which.
  it("names the place a volume is for", () => {
    expect(searchesIn("the United States")).toBe("Searches a month in the United States");
  });
});
