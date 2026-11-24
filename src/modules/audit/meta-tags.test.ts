import { describe, expect, it } from "vitest";
import { hasDuplicateTitleOrDescription, titleAndDescriptionCounts } from "./meta-tags";

describe("titleAndDescriptionCounts", () => {
  it("counts titles and descriptions in the head only", () => {
    const html = '<html><head><title>A</title><meta name="Description" content="x"></head><body><svg><title>icon</title></svg></body></html>';
    expect(titleAndDescriptionCounts(html)).toEqual({ titles: 1, descriptions: 1 });
  });

  it("doesn't count a theme-color pair for light and dark mode as a duplicate", () => {
    const html = '<head><title>A</title><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)"></head>';
    expect(hasDuplicateTitleOrDescription(html)).toBe(false);
  });

  it("finds two titles or two descriptions", () => {
    expect(hasDuplicateTitleOrDescription("<head><title>A</title><title>B</title></head>")).toBe(true);
    expect(hasDuplicateTitleOrDescription('<head><meta name="description" content="a"><meta name="description" content="b"></head>')).toBe(true);
  });
});

describe("titleAndDescriptionCounts on hostile pages", () => {
  it("reads an unclosed head and unclosed tags in linear time", () => {
    const MB2 = 2 * 1024 * 1024;
    const started = Date.now();
    titleAndDescriptionCounts("<head>" + "<meta ".repeat(MB2 / 6));
    titleAndDescriptionCounts("<head><meta " + "a".repeat(MB2));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(titleAndDescriptionCounts('<head><title>a</title><meta name="description" content="x"></head><body><meta name="description"></body>')).toEqual({ titles: 1, descriptions: 1 });
  });
});
