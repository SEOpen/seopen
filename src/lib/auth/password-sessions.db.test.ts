import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A new password signs every other browser out at once, against seopen_test. Two browsers are two
 * sign-ins, each keeping every cookie it was given, as a real one does. A row gone from `sessions` is
 * not enough: what counts is that the other browser's cookies get it nothing, from the proxy, the
 * auth endpoints or an app asking to connect.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));
// Signing in sends nothing here, whatever sign-up the copy has.
vi.mock("@/public-signup/server", async (original) => {
  const m = await original<typeof import("@/public-signup/server")>();
  return { ...m, signup: { ...m.signup, onSession: async () => undefined } };
});

const sent = vi.hoisted(() => [] as { to: string; text: string }[]);
vi.mock("@/lib/email", async (original) => ({
  ...(await original<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; text: string }) => void sent.push(msg),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const keys = await import("@/lib/mcp/keys");
const { auth } = await import("./index");
const { signInMethods } = await import("./sign-in-methods");
const { proxy } = await import("@/proxy");

const ORIGIN = "http://127.0.0.1:4100";
const PASSWORD = `pw-${randomUUID()}`;

/** The cookies a response sets, over the ones the browser already had. */
function keep(res: Response, had = ""): string {
  const jar = new Map(had.split("; ").filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c] as const));
  for (const set of res.headers.getSetCookie()) {
    const pair = set.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    if (/max-age=0/i.test(set)) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}

async function account() {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: `pw-${randomUUID()}@example.com`, name: "", emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
  const [ws] = await db.insert(s.workspaces).values({ name: `pw-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id });
  return { user, ws };
}

const post = (path: string, cookie: string, body: unknown) =>
  auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }));

/** A browser signing in, with every cookie it ends up holding after a first look at its session. */
async function browser(email: string, password = PASSWORD): Promise<string> {
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  expect(signIn.status).toBe(200);
  const cookie = keep(signIn);
  expect(cookie).toContain("session_token=");
  return keep(await auth.handler(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } })), cookie);
}

/** Starts a connection as an MCP app would; signed in, the provider sends the browser on to consent. */
async function authorize(cookie: string): Promise<string> {
  const redirect_uri = "http://127.0.0.1:33418/callback";
  const registered = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test agent", redirect_uris: [redirect_uri], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    }),
  );
  const { client_id } = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({ client_id, redirect_uri, response_type: "code", scope: "read", state: "x", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", resource: `${ORIGIN}/api/mcp` });
  const res = await auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, { headers: { cookie } }));
  return new URL(res.headers.get("location") ?? "/none", ORIGIN).pathname;
}

async function signedIn(cookie: string): Promise<boolean> {
  return Boolean(await auth.api.getSession({ headers: new Headers({ cookie }) }));
}

/** Everything the other browser's cookies must no longer do. */
async function expectSignedOut(cookie: string) {
  const page = await proxy(new NextRequest(`${ORIGIN}/settings`, { headers: { cookie, host: "127.0.0.1:4100" } }));
  expect(new URL(page.headers.get("location") ?? "/still-here", ORIGIN).pathname).toBe("/sign-in");
  const api = await proxy(new NextRequest(`${ORIGIN}/api/projects/current`, { headers: { cookie, host: "127.0.0.1:4100" } }));
  expect(api.status).toBe(401);
  expect(await signedIn(cookie)).toBe(false);
  const session = await auth.handler(new Request(`${ORIGIN}/api/auth/get-session`, { headers: { cookie } }));
  expect(await session.json()).toBeNull();
  // A connection made here would outlive the session.
  expect(await authorize(cookie)).toBe("/sign-in");
}

async function resetToken(userId: string): Promise<string> {
  const token = randomUUID();
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: userId, expiresAt: new Date(Date.now() + 3600_000) });
  return token;
}

describe.skipIf(!ready)("a new password signs out every other browser", () => {
  it("at once, when it's reset from an emailed link", async () => {
    const { user } = await account();
    const [a, b] = [await browser(user.email), await browser(user.email)];
    expect(await authorize(b)).toBe("/connect");

    const res = await post("/reset-password", "", { newPassword: `new-${randomUUID()}`, token: await resetToken(user.id) });
    expect(res.status).toBe(200);

    await expectSignedOut(a);
    await expectSignedOut(b);
  });

  it("at once, when it's changed by someone signed in, who stays signed in", async () => {
    const { user, ws } = await account();
    const [a, b] = [await browser(user.email), await browser(user.email)];
    const { key } = await keys.createApiKey({ workspaceId: ws.id, userId: user.id }, { name: "held by someone else" });
    await resetToken(user.id);
    const newPassword = `new-${randomUUID()}`;

    const res = await post("/change-password", a, { currentPassword: PASSWORD, newPassword, revokeOtherSessions: true });
    expect(res.status).toBe(200);

    await expectSignedOut(b);
    // The old cookie is spent here too; the answer carried a new one.
    await expectSignedOut(a);
    expect(await signedIn(keep(res, a))).toBe(true);
    expect(await keys.verifyApiKey(key)).toBeNull();
    expect(await db.$count(s.verifications, and(like(s.verifications.identifier, "reset-password:%"), eq(s.verifications.value, user.id)))).toBe(0);
    expect(await signedIn(await browser(user.email, newPassword))).toBe(true);
  });

  it.each([["left out", {}], ["false", { revokeOtherSessions: false }], ["not a boolean", { revokeOtherSessions: null }]])("whatever the request says: revokeOtherSessions %s", async (_, body) => {
    const { user, ws } = await account();
    const [a, b] = [await browser(user.email), await browser(user.email)];
    const { key } = await keys.createApiKey({ workspaceId: ws.id, userId: user.id }, { name: "held by someone else" });

    const res = await post("/change-password", a, { currentPassword: PASSWORD, newPassword: `new-${randomUUID()}`, ...body });
    expect(res.status).toBe(200);

    await expectSignedOut(b);
    expect(await keys.verifyApiKey(key)).toBeNull();
    expect(await signedIn(keep(res, a))).toBe(true);
  });

  it("but not when the current password is wrong", async () => {
    const { user, ws } = await account();
    const [a, b] = [await browser(user.email), await browser(user.email)];
    const { key } = await keys.createApiKey({ workspaceId: ws.id, userId: user.id }, { name: "mine" });

    const res = await post("/change-password", a, { currentPassword: "not-the-password", newPassword: `new-${randomUUID()}`, revokeOtherSessions: true });
    expect(res.status).toBe(400);

    expect(await signedIn(a)).toBe(true);
    expect(await signedIn(b)).toBe(true);
    expect(await keys.verifyApiKey(key)).not.toBeNull();
  });

  it("and leaves other accounts alone", async () => {
    const [mine, theirs] = [await account(), await account()];
    const [a, other] = [await browser(mine.user.email), await browser(theirs.user.email)];
    expect((await post("/change-password", a, { currentPassword: PASSWORD, newPassword: `new-${randomUUID()}` })).status).toBe(200);
    expect(await signedIn(other)).toBe(true);
  });

  it("a signed-out browser's cookies stop working too", async () => {
    const { user } = await account();
    const [a, b] = [await browser(user.email), await browser(user.email)];
    expect((await post("/sign-out", a, {})).status).toBe(200);
    await expectSignedOut(a);
    expect(await signedIn(b)).toBe(true);
  });
});

// Settings shows the form to an account with a password, and a link to set one to a Google account without.
describe.skipIf(!ready)("how an account signs in", () => {
  async function bare() {
    const ctx = await auth.$context;
    return ctx.internalAdapter.createUser({ email: `pw-${randomUUID()}@example.com`, name: "", emailVerified: true }, { method: "admin" });
  }

  it("with a password", async () => {
    expect(await signInMethods((await account()).user.id)).toEqual({ password: true, google: false });
  });

  it("with nothing yet, as no-login mode's owner, or with a credential that was cleared", async () => {
    const user = await bare();
    expect(await signInMethods(user.id)).toEqual({ password: false, google: false });
    const ctx = await auth.$context;
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id });
    expect(await signInMethods(user.id)).toEqual({ password: false, google: false });
  });

  it("with Google, and a password once the emailed link sets one", async () => {
    const user = await bare();
    const ctx = await auth.$context;
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "google", accountId: randomUUID() });
    expect(await signInMethods(user.id)).toEqual({ password: false, google: true });

    expect((await post("/request-password-reset", "", { email: user.email, redirectTo: "/reset-password" })).status).toBe(200);
    await vi.waitFor(() => expect(sent.some((m) => m.to === user.email)).toBe(true));
    const token = sent.find((m) => m.to === user.email)?.text.match(/reset-password\/([\w-]+)/)?.[1];
    const newPassword = `new-${randomUUID()}`;
    expect((await post("/reset-password", "", { newPassword, token })).status).toBe(200);
    expect(await signInMethods(user.id)).toEqual({ password: true, google: true });
    expect(await signedIn(await browser(user.email, newPassword))).toBe(true);
  });
});
