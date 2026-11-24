import { describe, expect, it, vi } from "vitest";
import type { Refusal } from "./errors";
import { checkRefusal, type CheckGateState } from "./check-gate";
import { FREE_PLAN_REFUSAL } from "./spend";
import { LOCKED_REFUSAL } from "./workspace";

vi.mock("server-only", () => ({}));

const refusal = (code: Refusal["code"]): Refusal => ({ code, upgradable: false, message: code });
const state = (over: Partial<CheckGateState> = {}): CheckGateState => ({ free: false, locked: new Set(), spend: null, research: null, audit: null, ...over });

describe("checkRefusal", () => {
  it("refuses nothing on a healthy plan", () => {
    for (const id of ["rank", "local", "ai", "audit", "google", "ga4"]) expect(checkRefusal(state(), id, 1)).toBeNull();
  });

  it("Free runs the audit only", () => {
    const free = state({ free: true });
    for (const id of ["rank", "local", "ai"]) expect(checkRefusal(free, id, 1)).toBe(FREE_PLAN_REFUSAL);
    expect(checkRefusal(free, "audit", 1)).toBeNull();
    expect(checkRefusal(state({ free: true, audit: refusal("free_audit") }), "audit", 1)?.code).toBe("free_audit");
  });

  it("a locked project refuses everything, syncs included", () => {
    const locked = state({ locked: new Set([1]) });
    for (const id of ["rank", "audit", "google", "ga4"]) expect(checkRefusal(locked, id, 1)).toBe(LOCKED_REFUSAL);
    expect(checkRefusal(locked, "rank", 2)).toBeNull();
  });

  it("a spend limit stops paid checks and not syncs, and credits stop Local only", () => {
    const stopped = state({ spend: refusal("ceiling"), research: refusal("ceiling") });
    for (const id of ["rank", "local", "ai", "audit"]) expect(checkRefusal(stopped, id, 1)?.code).toBe("ceiling");
    expect(checkRefusal(stopped, "google", 1)).toBeNull();
    const noCredits = state({ research: refusal("credits") });
    expect(checkRefusal(noCredits, "local", 1)?.code).toBe("credits");
    expect(checkRefusal(noCredits, "rank", 1)).toBeNull();
  });
});
