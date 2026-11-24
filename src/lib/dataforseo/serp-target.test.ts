import { describe, expect, it } from "vitest";
import { isGoogleRedirect, serpTarget } from "./serp-target";

// Shapes copied from a live serp/google/organic/live/advanced response on 2026-11-03.
describe("serpTarget", () => {
  it("passes a normal result through", () => {
    expect(serpTarget({ domain: "www.pinegatestudio.example", url: "https://www.pinegatestudio.example/", breadcrumb: "https://www.pinegatestudio.example" })).toEqual({
      domain: "www.pinegatestudio.example",
      url: "https://www.pinegatestudio.example/",
      originOnly: false,
      breadcrumb: null,
    });
  });

  it("keeps no breadcrumb for a normal result, even one with a path", () => {
    expect(serpTarget({ domain: "www.sitepoint.com", url: "https://www.sitepoint.com/backlink-checkers/", breadcrumb: "https://www.sitepoint.com › backlink-checkers" })).toEqual({
      domain: "www.sitepoint.com",
      url: "https://www.sitepoint.com/backlink-checkers/",
      originOnly: false,
      breadcrumb: null,
    });
  });

  it("recovers the real site of a google.com/goto result from its breadcrumb, and says the URL is only the origin", () => {
    expect(
      serpTarget({ domain: "google.com", url: "https://google.com/goto?url=CAESewHrOzAV2uAuCVESMHyf2R9k", breadcrumb: "https://www.linkedin.com › services › salem-nh" }),
    ).toEqual({ domain: "www.linkedin.com", url: "https://www.linkedin.com/", originOnly: true, breadcrumb: "services › salem-nh" });
    expect(serpTarget({ domain: "google.com", url: "https://google.com/goto?url=CAESXQ", breadcrumb: "https://granitewebsalem.com" })).toEqual({
      domain: "granitewebsalem.com",
      url: "https://granitewebsalem.com/",
      originOnly: true,
      breadcrumb: null,
    });
  });

  it("trims the breadcrumb and keeps Google's cut-off marker", () => {
    expect(serpTarget({ domain: "google.com", url: "https://google.com/goto?url=x", breadcrumb: "  https://www.sitepoint.com ›  blog  › top-10-best-free-backlink... " })).toMatchObject({
      url: "https://www.sitepoint.com/",
      originOnly: true,
      breadcrumb: "blog › top-10-best-free-backlink...",
    });
    expect(serpTarget({ domain: "google.com", url: "https://google.com/goto?url=x", breadcrumb: "https://example.com ›  " })).toMatchObject({ originOnly: true, breadcrumb: null });
  });

  it("says it doesn't know when a wrapped result has no usable breadcrumb", () => {
    const unknown = { domain: null, url: null, originOnly: false, breadcrumb: null };
    expect(serpTarget({ domain: "google.com", url: "https://google.com/goto?url=CAES", breadcrumb: null })).toEqual(unknown);
    expect(serpTarget({ domain: "google.com", url: "https://www.google.com/goto?url=CAES", breadcrumb: "Reddit › r/webdev" })).toEqual(unknown);
  });

  it("only treats google's goto links as redirects", () => {
    expect(isGoogleRedirect("https://google.com/goto?url=x")).toBe(true);
    expect(isGoogleRedirect("https://www.google.co.uk/goto?url=x")).toBe(true);
    expect(isGoogleRedirect("https://support.google.com/goto?x")).toBe(false);
    expect(isGoogleRedirect("https://example.com/goto?url=x")).toBe(false);
    expect(isGoogleRedirect(null)).toBe(false);
  });
});
