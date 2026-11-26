import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_MAX, poolMax } from "./pool";

describe("poolMax", () => {
  it("is 5 unset", () => {
    expect(poolMax(undefined)).toBe(DEFAULT_POOL_MAX);
    expect(poolMax("")).toBe(5);
    expect(poolMax("  ")).toBe(5);
  });

  it("takes a whole number from 1 to 100", () => {
    expect(poolMax("1")).toBe(1);
    expect(poolMax(" 15 ")).toBe(15);
    expect(poolMax("100")).toBe(100);
  });

  it("ignores anything else", () => {
    for (const v of ["0", "-3", "101", "7.5", "ten", "1e1"]) expect(poolMax(v)).toBe(5);
  });
});
