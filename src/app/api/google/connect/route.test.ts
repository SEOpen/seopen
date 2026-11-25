import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");

vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ id: "u1" }) }));
vi.mock("@/modules/google/auth", () => ({
  oauthConfigured: () => true,
  newOAuthClient: () => ({
    generateCodeVerifierAsync: async () => ({ codeVerifier: "verifier", codeChallenge: "challenge" }),
    generateAuthUrl: () => "https://accounts.google.com/o/oauth2/v2/auth?state=x",
  }),
}));

const { GET } = await import("./route");
const { readOAuthCookie } = await import("@/modules/google/oauth-cookie");

describe("GET /api/google/connect", () => {
  it("keeps the state cookie httpOnly, Secure and on /api/google", async () => {
    const res = await GET();
    expect(res.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("seopen_google_oauth="));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; Path=\/api\/google/);
    expect(cookie).toMatch(/; SameSite=lax/i);
    expect(readOAuthCookie(decodeURIComponent(cookie!.split(";")[0].split("=").slice(1).join("=")))?.userId).toBe("u1");
  });
});
