import { describe, expect, it } from "vitest";
import { radioStep } from "./radio-keys";

describe("radioStep", () => {
  it("moves forward and back with either pair of arrows", () => {
    expect(radioStep("ArrowRight", 0, 3)).toBe(1);
    expect(radioStep("ArrowDown", 1, 3)).toBe(2);
    expect(radioStep("ArrowLeft", 2, 3)).toBe(1);
    expect(radioStep("ArrowUp", 1, 3)).toBe(0);
  });

  it("wraps at both ends", () => {
    expect(radioStep("ArrowRight", 2, 3)).toBe(0);
    expect(radioStep("ArrowLeft", 0, 3)).toBe(2);
  });

  it("leaves other keys alone", () => {
    expect(radioStep("Tab", 0, 3)).toBeNull();
    expect(radioStep("Enter", 0, 3)).toBeNull();
  });
});
