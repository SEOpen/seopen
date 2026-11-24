import { describe, expect, it } from "vitest";
import { isSiteWide, splitSiteWide } from "./site-wide";

describe("site-wide notices", () => {
  it("are notices on 90% or more of the crawled pages, and on at least 10", () => {
    expect(isSiteWide({ severity: "notice", count: 49 }, 49)).toBe(true);
    expect(isSiteWide({ severity: "notice", count: 45 }, 50)).toBe(true);
    expect(isSiteWide({ severity: "notice", count: 44 }, 50)).toBe(false);
    // A 9-page site is too small to call anything site-wide.
    expect(isSiteWide({ severity: "notice", count: 9 }, 9)).toBe(false);
    expect(isSiteWide({ severity: "notice", count: 10 }, 10)).toBe(true);
  });

  it("never take in an error or a warning, or a crawl with no page count", () => {
    expect(isSiteWide({ severity: "warning", count: 49 }, 49)).toBe(false);
    expect(isSiteWide({ severity: "error", count: 49 }, 49)).toBe(false);
    expect(isSiteWide({ severity: "notice", count: 49 }, null)).toBe(false);
    expect(isSiteWide({ severity: "notice", count: 49 }, 0)).toBe(false);
  });

  it("split a list without changing its order", () => {
    const rows = [
      { code: "a", severity: "warning" as const, count: 49 },
      { code: "low-text-ratio", severity: "notice" as const, count: 49 },
      { code: "b", severity: "notice" as const, count: 3 },
      { code: "render-blocking", severity: "notice" as const, count: 48 },
    ];
    const { rest, siteWide } = splitSiteWide(rows, 49);
    expect(rest.map((r) => r.code)).toEqual(["a", "b"]);
    expect(siteWide.map((r) => r.code)).toEqual(["low-text-ratio", "render-blocking"]);
  });
});
