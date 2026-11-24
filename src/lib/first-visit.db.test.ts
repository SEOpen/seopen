import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Where a self sign-up's first visit came from, through real Better Auth calls against
 * seopen_test with sign-up open: kept when the account is made by email or by Google's callback,
 * cut to fit rather than refused, never one of our own hosts, and never changed by a later sign-up
 * or sign-in. Email is captured, so nothing reaches Resend.
 */

vi.stubEnv("SEOPEN_SIGNUP_OPEN", "1");
vi.stubEnv("SEOPEN_SITE_HOST", "seopen.example");
vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; subject: string; text: string }) => void sent.push(msg),
}));

const ready = await testDb();

const { db } = await import("@/db");
const { users } = await import("@/db/schema");
const { auth, authBaseUrl } = await import("@/lib/auth");
const { createInvitedAccount } = await import("./invites");

const tag = () => randomUUID().slice(0, 8);
const PASSWORD = "correct-horse-battery";
const visitOf = async (email: string) =>
  (await db.select({ source: users.firstSource, referrerHost: users.firstReferrerHost, landingPath: users.firstLandingPath }).from(users).where(eq(users.email, email)))[0];

const signUp = (email: string, firstVisit?: unknown) => auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "", ...(firstVisit === undefined ? {} : { firstVisit }) } });

/** Opens the last confirmation link to this address. */
async function confirm(email: string) {
  const mail = sent.filter((m) => m.to === email && m.subject === "Confirm your SEOpen email").at(-1);
  const token = mail?.text.match(/verify-email\?token=([\w.-]+)/)?.[1];
  if (!token) throw new Error(`no confirmation email for ${email}`);
  await auth.api.verifyEmail({ query: { token } });
}

const idToken = (claims: Record<string, unknown>) =>
  ["none", claims].map((part) => Buffer.from(JSON.stringify(part === "none" ? { alg: "none", typ: "JWT" } : part)).toString("base64url")).join(".") + ".";

/**
 * Google sign-in as the browser does it: the sign-up page starts it with `additionalData`, Google
 * sends the browser back to the callback with a code and the state, and Better Auth trades the code
 * for tokens. Only that trade is faked, so the visit makes the real round trip through the state.
 */
async function googleSignIn(email: string, additionalData?: Record<string, unknown>): Promise<string> {
  const start = await auth.api.signInSocial({ body: { provider: "google", callbackURL: "/", disableRedirect: true, additionalData }, asResponse: true });
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const sub = `sub-${tag()}`;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (!target.startsWith("https://oauth2.googleapis.com/token")) return realFetch(input, init);
    const token = idToken({ sub, email, email_verified: true, name: "Pat", aud: "test-client-id", iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600 });
    return Response.json({ access_token: "made-up-access", id_token: token, expires_in: 3600, token_type: "Bearer", scope: "openid email profile" });
  });
  try {
    const res = await auth.handler(new Request(`${authBaseUrl()}/api/auth/callback/google?code=made-up-code&state=${state}`, { headers: { cookie } }));
    return res.headers.get("location") ?? "";
  } finally {
    vi.unstubAllGlobals();
  }
}

describe.skipIf(!ready)("first-visit source on new accounts", () => {
  afterEach(() => void (sent.length = 0));

  it("keeps an email sign-up's visit when the account is made", async () => {
    const email = `fv-email-${tag()}@example.com`;
    await signUp(email, { source: "newsletter", referrerHost: "News.Example.com", landingPath: "/pricing" });
    expect(await visitOf(email)).toEqual({ source: "newsletter", referrerHost: "news.example.com", landingPath: "/pricing" });
  });

  it("never changes it: not by a second sign-up for the address, nor by signing in with Google later", async () => {
    const email = `fv-again-${tag()}@example.com`;
    await signUp(email, { source: "first", referrerHost: "first.example", landingPath: "/" });
    await signUp(email, { source: "second", referrerHost: "second.example", landingPath: "/tools" });
    expect(await visitOf(email)).toEqual({ source: "first", referrerHost: "first.example", landingPath: "/" });
    await confirm(email);
    const location = await googleSignIn(email, { firstVisit: { source: "third", referrerHost: "third.example", landingPath: "/features" } });
    expect(location).not.toContain("error=");
    expect(await visitOf(email)).toEqual({ source: "first", referrerHost: "first.example", landingPath: "/" });
  });

  it("carries a Google sign-up's visit through the OAuth state to the new account", async () => {
    const email = `fv-google-${tag()}@example.com`;
    const location = await googleSignIn(email, { firstVisit: { source: "producthunt", referrerHost: "www.producthunt.com", landingPath: "/features/rank-tracking" } });
    expect(location).not.toContain("error=");
    expect(await visitOf(email)).toEqual({ source: "producthunt", referrerHost: "www.producthunt.com", landingPath: "/features/rank-tracking" });
  });

  it("makes a Google account with nothing when the sign-up page had no visit", async () => {
    const email = `fv-google-none-${tag()}@example.com`;
    await googleSignIn(email);
    expect(await visitOf(email)).toEqual({ source: null, referrerHost: null, landingPath: null });
  });

  it("cuts oversized values and drops junk instead of refusing the sign-up", async () => {
    const email = `fv-junk-${tag()}@example.com`;
    await signUp(email, { source: "s".repeat(500), referrerHost: "not a host/at all", landingPath: `/${"p".repeat(400)}` });
    expect(await visitOf(email)).toEqual({ source: "s".repeat(100), referrerHost: null, landingPath: `/${"p".repeat(199)}` });

    const odd = `fv-odd-${tag()}@example.com`;
    await signUp(odd, "not an object");
    expect(await visitOf(odd)).toEqual({ source: null, referrerHost: null, landingPath: null });

    const typed = `fv-typed-${tag()}@example.com`;
    await signUp(typed, { source: 42, referrerHost: ["a"], landingPath: "pricing?x=1" });
    expect(await visitOf(typed)).toEqual({ source: null, referrerHost: null, landingPath: null });
  });

  it("never keeps one of our own hosts as the site that linked", async () => {
    for (const host of ["seopen.example", "app.seopen.example", "www.seopen.example"]) {
      const email = `fv-own-${tag()}@example.com`;
      await signUp(email, { source: "x", referrerHost: host, landingPath: "/" });
      expect((await visitOf(email)).referrerHost).toBeNull();
    }
  });

  it("can't be set through the user fields Better Auth takes from a request", async () => {
    const email = `fv-field-${tag()}@example.com`;
    // Built first: the body's type lists only Better Auth's own fields, and a browser can send anything.
    const body = { email, password: PASSWORD, name: "", firstSource: "spoofed" };
    await expect(auth.api.signUpEmail({ body })).rejects.toMatchObject({ statusCode: 400 });
    expect(await visitOf(email)).toBeUndefined();
  });

  it("gives invited accounts nothing", async () => {
    const email = `fv-invite-${tag()}@example.com`;
    await createInvitedAccount(email);
    expect(await visitOf(email)).toEqual({ source: null, referrerHost: null, landingPath: null });
  });
});
