import { describe, expect, it } from "vitest";
import { capError, parseCap } from "./caps";

describe("parseCap", () => {
  it("takes a number from 1 to the maximum", () => {
    expect(parseCap("1", 100)).toBe(1);
    expect(parseCap("99.5", 100)).toBe(99.5);
    expect(parseCap(" 100 ", 100)).toBe(100);
  });

  it("refuses a blank field rather than reading it as 0", () => {
    expect(parseCap("", 100)).toBeNull();
    expect(parseCap("   ", 100)).toBeNull();
    expect(parseCap(null, 100)).toBeNull();
  });

  it("refuses what's out of range or not a number", () => {
    expect(parseCap("0", 100)).toBeNull();
    expect(parseCap("-5", 100)).toBeNull();
    expect(parseCap("101", 100)).toBeNull();
    expect(parseCap("abc", 100)).toBeNull();
    expect(parseCap("Infinity", 100)).toBeNull();
  });
});

describe("capError", () => {
  it("names the range", () => {
    expect(capError(100_000)).toBe("Enter a cap between $1 and $100,000.");
  });
});
