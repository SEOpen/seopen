import { describe, expect, it } from "vitest";
import { SpendRefusedError } from "@/lib/billing/errors";
import { anyRefused, failuresToShow } from "./failures";

const refused = (code: "suspended" | "ceiling") => new SpendRefusedError(7, { code, message: "No.", upgradable: false });
const failed = (error: unknown) => ({ ok: false as const, error });
const fine = { ok: true as const };

describe("failuresToShow", () => {
  it("says one refusal once, however many loads it stopped", () => {
    const [a, b] = [refused("ceiling"), refused("ceiling")];
    expect([...failuresToShow([null, failed(a), failed(b)], null)]).toEqual([a]);
  });

  it("says nothing when the banner already says it", () => {
    expect(failuresToShow([failed(refused("suspended")), failed(refused("suspended"))], "suspended").size).toBe(0);
  });

  it("still says a different refusal from the banner's", () => {
    const a = refused("ceiling");
    expect([...failuresToShow([failed(a)], "suspended")]).toEqual([a]);
  });

  it("keeps every other failure, each is about its own load", () => {
    const [a, b] = [new Error("one"), new Error("two")];
    expect([...failuresToShow([failed(a), fine, failed(b)], "suspended")]).toEqual([a, b]);
  });
});

describe("anyRefused", () => {
  it("only asks about a refusal", () => {
    expect(anyRefused([null, fine, failed(new Error("no"))])).toBe(false);
    expect(anyRefused([fine, failed(refused("ceiling"))])).toBe(true);
  });
});
