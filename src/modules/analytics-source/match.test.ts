import { describe, expect, it } from "vitest";
import type { Ga4Property } from "@/modules/google/matching";
import { chosenLinks, scorePlausibleSite, scorePosthogProject, sourceMatches, startingSource } from "./match";

const ga4 = (property: string, streamDomains: string[], propertyName = "Site"): Ga4Property => ({ property, propertyName, account: "accounts/1", accountName: "Acct", streamDomains });
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("scorePlausibleSite", () => {
  it("matches the domain exactly, or a subdomain either way", () => {
    expect(scorePlausibleSite("https://www.alphanote.test/", { domain: "alphanote.test" })).toBe(100);
    expect(scorePlausibleSite("alphanote.test", { domain: "blog.alphanote.test" })).toBe(70);
    expect(scorePlausibleSite("shop.alphanote.test", { domain: "alphanote.test" })).toBe(70);
    expect(scorePlausibleSite("alphanote.test", { domain: "notalphanote.test" })).toBe(0);
  });
});

describe("scorePosthogProject", () => {
  it("guesses from the name: the whole address, then its first label as a word", () => {
    expect(scorePosthogProject("alphanote.test", { id: "1", name: "alphanote.test production" })).toBe(50);
    expect(scorePosthogProject("alphanote.test", { id: "1", name: "Alphanote" })).toBe(30);
    expect(scorePosthogProject("alphanote.test", { id: "1", name: "Default project" })).toBe(0);
    // A short label is too likely to match by chance.
    expect(scorePosthogProject("abc.io", { id: "1", name: "abc dashboard" })).toBe(0);
  });
});

describe("startingSource", () => {
  const all = ["GA4", "PostHog", "Plausible"] as const;

  it("starts on the strongest match, whatever the source", () => {
    const matches = sourceMatches("alphanote.test", {
      ga4: [ga4("properties/9", [], "Alphanote")],
      posthog: [{ id: "7", name: "Other" }],
      plausible: [{ domain: "alphanote.test" }],
    });
    expect(matches.GA4?.score).toBe(30);
    expect(matches.PostHog).toBeNull();
    expect(matches.Plausible).toEqual({ source: "Plausible", value: "alphanote.test", score: 100 });
    expect(startingSource([...all], [...all], matches)).toBe("Plausible");
  });

  it("keeps GA4 on a tie", () => {
    const matches = sourceMatches("alphanote.test", { ga4: [ga4("properties/9", ["alphanote.test"])], plausible: [{ domain: "alphanote.test" }] });
    expect(startingSource([...all], [...all], matches)).toBe("GA4");
  });

  it("with no match, starts on the first connected source, then the first offered", () => {
    const none = sourceMatches("alphanote.test", {});
    expect(startingSource([...all], ["PostHog"], none)).toBe("PostHog");
    expect(startingSource(["PostHog", "Plausible"], [], none)).toBe("PostHog");
    expect(startingSource([], [], none)).toBeNull();
  });

  it("ignores a match from a source that isn't offered", () => {
    const matches = sourceMatches("alphanote.test", { plausible: [{ domain: "alphanote.test" }] });
    expect(startingSource(["GA4", "PostHog"], ["GA4"], matches)).toBe("GA4");
  });
});

describe("chosenLinks", () => {
  it("sends only the field of the source the switch was on", () => {
    const f = form({ analyticsSource: "PostHog", gscProperty: "sc-domain:alphanote.test", ga4Property: "properties/9", posthogProject: "7", plausibleSite: "alphanote.test" });
    expect(chosenLinks(f)).toEqual({ gscProperty: "sc-domain:alphanote.test", ga4Property: "", other: { source: "PostHog", value: "7" } });
  });

  it("links nothing for a source left on None", () => {
    expect(chosenLinks(form({ analyticsSource: "Plausible", plausibleSite: "" })).other).toBeNull();
  });

  it("reads a form with no switch value, or an unknown one, as GA4", () => {
    expect(chosenLinks(form({ ga4Property: "properties/9" }))).toEqual({ gscProperty: "", ga4Property: "properties/9", other: null });
    expect(chosenLinks(form({ analyticsSource: "Umami", ga4Property: "properties/9", posthogProject: "7" })).other).toBeNull();
  });
});
