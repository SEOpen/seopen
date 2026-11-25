import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const save = vi.hoisted(() => vi.fn(async () => {}));

process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");

vi.mock("@/lib/analytics/server", () => ({ track: () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ id: "u1" }) }));
vi.mock("@/lib/workspace/current", () => ({ workspaceScope: async () => ({ workspaceId: 1 }) }));
vi.mock("@/plan-policy/hooks", () => ({ hooks: {} }));
vi.mock("@/modules/google/auth", () => ({ newOAuthClient: () => ({}), saveAccount: save }));
vi.mock("@/modules/google/properties", () => ({ forgetGoogleProperties: () => {} }));

const { GET } = await import("./route");
const { encrypt } = await import("@/lib/crypto");
const { OAUTH_COOKIE } = await import("@/modules/google/oauth-cookie");

// What request.url says behind a proxy: the address the server listens on, not the one the browser uses.
const request = (query: string) => new NextRequest(`https://0.0.0.0:4100/api/google/callback?${query}`);

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/google/callback", () => {
  it("sends the browser back to the app's own address", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.seopen.example");
    const denied = await GET(request("error=access_denied"));
    expect(denied.headers.get("location")).toBe("https://app.seopen.example/gsc?google_error=access_denied");
    const mismatch = await GET(request("state=x&code=y"));
    expect(mismatch.headers.get("location")).toBe("https://app.seopen.example/gsc?google_error=state_mismatch");
  });

  it("connects nothing when another account is signed in than the one that started", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.seopen.example");
    const req = request("state=x&code=y");
    req.cookies.set(OAUTH_COOKIE, encrypt(JSON.stringify({ state: "x", codeVerifier: "v", userId: "someone-else" })));
    const res = await GET(req);
    expect(res.headers.get("location")).toBe("https://app.seopen.example/gsc?google_error=account_changed");
    expect(save).not.toHaveBeenCalled();
  });
});
