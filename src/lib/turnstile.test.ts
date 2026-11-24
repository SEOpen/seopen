import { afterEach, describe, expect, it, vi } from "vitest";
import { TURNSTILE_ACTION, turnstileSiteKey, verifyTurnstile } from "./turnstile";

const SECRET = { TURNSTILE_SECRET_KEY: "secret-abc", NODE_ENV: "production" };
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.restoreAllMocks());

describe("verifyTurnstile", () => {
  it("passes a token Cloudflare accepts for the sign-up action, sending the secret and token", async () => {
    const fetchImpl = answer({ success: true, action: TURNSTILE_ACTION });
    expect(await verifyTurnstile("tok", { env: SECRET, fetchImpl })).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const sent = new URLSearchParams(init.body as URLSearchParams);
    expect(sent.get("secret")).toBe("secret-abc");
    expect(sent.get("response")).toBe("tok");
  });

  it("refuses a token Cloudflare rejects, or one from another widget's action", async () => {
    for (const body of [{ success: false }, { success: true, action: "login" }, { success: true }, { success: "true", action: TURNSTILE_ACTION }]) {
      expect(await verifyTurnstile("tok", { env: SECRET, fetchImpl: answer(body) })).toMatchObject({ ok: false, status: 403, code: "BOT_DETECTED" });
    }
  });

  it("refuses a missing or oversized token without asking Cloudflare", async () => {
    const fetchImpl = answer({ success: true, action: TURNSTILE_ACTION });
    for (const token of [null, "", "x".repeat(2049)]) {
      expect(await verifyTurnstile(token, { env: SECRET, fetchImpl })).toMatchObject({ ok: false, status: 403 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when Cloudflare can't be reached or answers badly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    for (const fetchImpl of [down, answer({}, 500), vi.fn(async () => new Response("not json"))]) {
      expect(await verifyTurnstile("tok", { env: SECRET, fetchImpl })).toMatchObject({ ok: false, status: 503, code: "SIGNUP_CHECK_UNAVAILABLE" });
    }
  });

  it("refuses every sign-up in production without a secret, and lets development through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = answer({ success: true, action: TURNSTILE_ACTION });
    expect(await verifyTurnstile("tok", { env: { NODE_ENV: "production" }, fetchImpl })).toMatchObject({ ok: false, status: 503 });
    expect(await verifyTurnstile("tok", { env: { NODE_ENV: "production", TURNSTILE_SECRET_KEY: " " }, fetchImpl })).toMatchObject({ ok: false, status: 503 });
    expect(await verifyTurnstile(null, { env: { NODE_ENV: "development" }, fetchImpl })).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("turnstileSiteKey", () => {
  it("is the trimmed key, or null when unset", () => {
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: " 0x4AAA " })).toBe("0x4AAA");
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: "" })).toBeNull();
    expect(turnstileSiteKey({})).toBeNull();
  });
});
