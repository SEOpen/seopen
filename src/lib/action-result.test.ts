import { describe, expect, it } from "vitest";
import { refusalResult } from "./action-result";

describe("refusalResult", () => {
  it("keeps the reason and whether Upgrade now helps", () => {
    expect(refusalResult({ code: "trial_lighthouse", upgradable: true, message: "Lighthouse isn't part of the trial." })).toEqual({
      error: "Lighthouse isn't part of the trial.",
      upgradable: true,
    });
    expect(refusalResult({ code: "locked", upgradable: false, message: "This project is read-only." })).toEqual({ error: "This project is read-only.", upgradable: false });
  });
});
