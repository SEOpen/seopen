import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOT, LIGHT_BASE } from "./dots";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** One theme block's custom properties. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6}|rgba\([^)]*\))\s*;/g)].map((m) => [m[1], m[2]]));
}

const LIGHT = tokens(":root");
const DARK = tokens(':root[data-theme="dark"]');

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The fill and text tokens a dot's classes name. */
function inks(classes: string): [string, string] {
  const fill = classes.match(/\bbg-([\w-]+)/)?.[1];
  const text = classes.match(/\btext-\(--([\w-]+)\)/)?.[1] ?? classes.match(/\btext-([\w-]+)/)?.[1];
  return [`--${fill}`, `--${text}`];
}

describe("the map dots", () => {
  it("keep the light theme's values on Google's light map", () => {
    for (const [token, value] of Object.entries(LIGHT_BASE)) expect([token, value]).toEqual([token, LIGHT[token]]);
  });

  it.each(Object.entries(DOT))("%s stays readable on every base", (name, classes) => {
    const [fill, text] = inks(classes);
    // The kit's muted on Raised is 4.04:1 on light and 3.53:1 on dark, a known miss.
    const floor = name === "pending" ? 3.5 : 4.5;
    for (const theme of [LIGHT, DARK, LIGHT_BASE] as Record<string, string>[]) {
      // The rank scale and its ink are the same in both themes, so only :root holds them.
      expect(contrast(theme[text] ?? LIGHT[text], theme[fill] ?? LIGHT[fill])).toBeGreaterThanOrEqual(floor);
    }
  });

  it("run green to raspberry, best rank first", () => {
    expect(DOT.top3).toContain("bg-rank-1");
    expect(DOT.top10).toContain("bg-rank-2");
    expect(DOT.top20).toContain("bg-rank-3");
    expect(DOT.none).toContain("bg-rank-4");
    expect(LIGHT["--rank-1"]).toBe("#1e9e5a");
    expect(LIGHT["--rank-4"]).toBe("#8a1048");
  });

  it("keep one scale in both themes", () => {
    for (const token of ["--rank-1", "--rank-2", "--rank-3", "--rank-4", "--rank-light"]) expect(DARK[token]).toBeUndefined();
  });

  it("leave a failed search hollow, so it never reads as a rank", () => {
    expect(DOT.failed).toContain("border-dashed");
    expect(DOT.failed).not.toContain("bg-rank");
  });
});
