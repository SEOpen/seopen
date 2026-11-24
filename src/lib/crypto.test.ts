import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: () => ({ SEOPEN_SECRET_KEY: process.env.SEOPEN_SECRET_KEY }) }));
const { decrypt, encrypt } = await import("./crypto");

describe("encrypt and decrypt", () => {
  beforeAll(() => {
    process.env.SEOPEN_SECRET_KEY = randomBytes(32).toString("base64");
  });

  it("round-trips, and a changed byte fails", () => {
    const sealed = encrypt("refresh-token-fixture");
    expect(decrypt(sealed)).toBe("refresh-token-fixture");
    const buf = Buffer.from(sealed, "base64");
    buf[buf.length - 1] ^= 1;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });

  it("refuses a payload cut short into the tag, rather than checking a shorter tag", () => {
    const buf = Buffer.from(encrypt(""), "base64");
    expect(buf.length).toBe(28);
    for (const n of [27, 16, 12]) expect(() => decrypt(buf.subarray(0, n).toString("base64"))).toThrow();
  });
});
