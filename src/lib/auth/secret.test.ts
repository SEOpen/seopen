import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
const { authSecret } = await import("./index");

afterEach(() => vi.unstubAllEnvs());

describe("authSecret", () => {
  it("prefers BETTER_AUTH_SECRET", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "explicit");
    expect(authSecret()).toBe("explicit");
  });

  it("derives a stable secret from SEOPEN_SECRET_KEY that differs from it", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const key = Buffer.alloc(32, 7).toString("base64");
    vi.stubEnv("SEOPEN_SECRET_KEY", key);
    const secret = authSecret();
    expect(secret).toHaveLength(44);
    expect(secret).not.toBe(key);
    expect(authSecret()).toBe(secret);
  });

  it("gives nothing without a usable key", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("SEOPEN_SECRET_KEY", "short");
    expect(authSecret()).toBeUndefined();
  });
});
