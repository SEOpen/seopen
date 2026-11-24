import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auth route's Turnstile guard: with sign-up open, an email sign-up whose token fails gets a 403
 * (or a 503 when the check can't run) and never reaches Better Auth; everything else goes straight
 * to Better Auth, and with sign-up closed nothing is checked. Better Auth and the check are stand-ins
 * here; src/lib/turnstile.test.ts tests the check, signup.db.test.ts the real Better Auth.
 */

const handler = vi.hoisted(() => vi.fn(async () => new Response("better auth")));
vi.mock("@/lib/auth", () => ({ auth: { handler } }));
const verifyTurnstile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/turnstile", async (original) => ({ ...(await original<typeof import("@/lib/turnstile")>()), verifyTurnstile }));

const { GET, POST } = await import("./route");

const post = (path: string, token?: string) =>
  POST(new Request(`https://app.getseopen.com${path}`, { method: "POST", body: "{}", headers: token ? { "x-turnstile-token": token } : {} }));
const refused = { ok: false, status: 403, code: "BOT_DETECTED", message: "The sign-up check didn't pass. Reload the page and try again." };
const passed = { ok: true };

beforeEach(() => {
  vi.stubEnv("SEOPEN_SIGNUP_OPEN", "1");
  handler.mockClear();
  verifyTurnstile.mockReset();
  verifyTurnstile.mockResolvedValue(passed);
});
afterEach(() => vi.unstubAllEnvs());

describe("the auth route's Turnstile guard", () => {
  it("answers a failed check 403 before Better Auth runs", async () => {
    verifyTurnstile.mockResolvedValue(refused);
    const res = await post("/api/auth/sign-up/email", "bad");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "BOT_DETECTED" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 503 when the check can't run", async () => {
    verifyTurnstile.mockResolvedValue({ ok: false, status: 503, code: "SIGNUP_CHECK_UNAVAILABLE", message: "…" });
    expect((await post("/api/auth/sign-up/email", "t")).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks a variant spelling of the path too", async () => {
    verifyTurnstile.mockResolvedValue(refused);
    for (const path of ["/api/auth/sign-up/email/", "/API/Auth/Sign-Up/Email"]) expect((await post(path)).status, path).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the form's token to the check, and a passing sign-up on to Better Auth", async () => {
    const res = await post("/api/auth/sign-up/email", "tok-123");
    expect(await res.text()).toBe("better auth");
    expect(verifyTurnstile).toHaveBeenCalledWith("tok-123");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("checks a sign-up with no token too (the check refuses it)", async () => {
    await post("/api/auth/sign-up/email");
    expect(verifyTurnstile).toHaveBeenCalledWith(null);
  });

  it("sends every other auth request straight to Better Auth", async () => {
    verifyTurnstile.mockResolvedValue(refused);
    for (const path of ["/api/auth/sign-in/email", "/api/auth/request-password-reset", "/api/auth/sign-in/social", "/api/auth/sign-up/email-otp"]) {
      expect(await (await post(path)).text(), path).toBe("better auth");
    }
    const request = new Request("https://app.getseopen.com/api/auth/sign-up/email");
    expect(await (await GET(request)).text()).toBe("better auth");
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it("checks nothing with sign-up closed", async () => {
    vi.stubEnv("SEOPEN_SIGNUP_OPEN", "");
    verifyTurnstile.mockResolvedValue(refused);
    expect(await (await post("/api/auth/sign-up/email")).text()).toBe("better auth");
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });
});
