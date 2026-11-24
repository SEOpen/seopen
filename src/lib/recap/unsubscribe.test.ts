import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRecapPlan, recapOpen } from "./gate";
import { unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "./unsubscribe";

describe("unsubscribe links", () => {
  beforeEach(() => vi.stubEnv("SEOPEN_SECRET_KEY", Buffer.alloc(32, 7).toString("base64")));
  afterEach(() => vi.unstubAllEnvs());

  it("say whose recap they are", () => {
    expect(verifyUnsubscribeToken(unsubscribeToken("user-1"))).toBe("user-1");
    expect(unsubscribeUrl("https://app.example.test", "user-1")).toBe(`https://app.example.test/api/email/unsubscribe?t=${unsubscribeToken("user-1")}`);
  });

  it("refuse another id, a changed signature, another key or anything malformed", () => {
    const [, signature] = unsubscribeToken("user-1").split(".");
    expect(verifyUnsubscribeToken(`${Buffer.from("user-2").toString("base64url")}.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${unsubscribeToken("user-1")}x`)).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("abc")).toBeNull();
    expect(verifyUnsubscribeToken(`${unsubscribeToken("user-1")}.more`)).toBeNull();
    expect(verifyUnsubscribeToken(null)).toBeNull();
    const token = unsubscribeToken("user-1");
    vi.stubEnv("SEOPEN_SECRET_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("keep the recap and alerts lists apart", () => {
    const alerts = unsubscribeToken("user-1", "alerts");
    expect(verifyUnsubscribeToken(alerts, "alerts")).toBe("user-1");
    expect(verifyUnsubscribeToken(alerts)).toBeNull();
    expect(verifyUnsubscribeToken(unsubscribeToken("user-1"), "alerts")).toBeNull();
    expect(unsubscribeUrl("https://app.example.test", "user-1", "alerts")).toBe(`https://app.example.test/api/email/unsubscribe?t=${alerts}&list=alerts`);
  });
});

describe("recap plans", () => {
  it("are Starter, Pro, trial and internal, not Free", () => {
    for (const plan of ["starter", "pro", "trial", "internal"]) expect(onRecapPlan({ plan })).toBe(true);
    for (const plan of ["free", "none", "unknown"]) expect(onRecapPlan({ plan })).toBe(false);
  });

  it("open to the owner's workspace only for now", () => {
    expect(recapOpen({ plan: "internal" })).toBe(true);
    for (const plan of ["starter", "pro", "trial", "free"]) expect(recapOpen({ plan })).toBe(false);
  });
});
