import { describe, expect, it } from "vitest";
import { isAuthPage, safeCallback } from "./redirect";

describe("safeCallback", () => {
  it("keeps same-site paths", () => {
    expect(safeCallback("/rank?x=1")).toBe("/rank?x=1");
  });

  it("drops run, so a link can't spend by way of sign-in", () => {
    expect(safeCallback("/keywords/ideas?q=dummy+seed&loc=2840&mode=related&run=1")).toBe("/keywords/ideas?q=dummy+seed&loc=2840&mode=related");
    expect(safeCallback("/serp?run=1")).toBe("/serp");
    expect(safeCallback("/serp?run=1&run=1#top")).toBe("/serp#top");
    // Only a param named run: others that contain the word stay, as written.
    expect(safeCallback("/rank?rerun=1&q=a%20b")).toBe("/rank?rerun=1&q=a%20b");
  });

  it("rejects other sites, odd input and auth pages", () => {
    for (const raw of ["https://evil.test", "//evil.test", "/\\evil.test", "rank", "/a\u0000b", 42, undefined, "/sign-in", "/login?next=/x", "/set-password?next=/rank"]) {
      expect(safeCallback(raw)).toBe("/");
    }
  });
});

describe("isAuthPage", () => {
  it("lists the public auth pages and the auth API", () => {
    expect(isAuthPage("/sign-in")).toBe(true);
    expect(isAuthPage("/set-password")).toBe(true);
    expect(isAuthPage("/api/auth/callback/google")).toBe(true);
    expect(isAuthPage("/api/google/callback")).toBe(false);
    expect(isAuthPage("/rank")).toBe(false);
  });
});
