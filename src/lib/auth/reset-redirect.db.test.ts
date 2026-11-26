import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A reset link lands on the reset page, whatever the request for it asked. The link carries its
 * token to the page it lands on, so a caller who could pick that page would pick who reads the token.
 * The token is in the link's query, never its path: a firewall or proxy can mask a query value in
 * what it keeps of a request, and not a path (resetPageLink, ./reset-links.ts).
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@/public-signup/server", async (original) => {
  const m = await original<typeof import("@/public-signup/server")>();
  return { ...m, signup: { ...m.signup, onSession: async () => undefined } };
});

const sent = vi.hoisted(() => [] as { to: string; text: string }[]);
vi.mock("@/lib/email", async (original) => ({
  ...(await original<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; text: string }) => void sent.push(msg),
}));

await testDb();

const { auth } = await import("./index");
const { authBaseUrl } = await import("./base-url");
const { resetTokenUsable } = await import("./reset-links");

const ORIGIN = authBaseUrl();

async function account() {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: `reset-${randomUUID()}@example.com`, name: "", emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(`pw-${randomUUID()}`) });
  return user;
}

const post = (path: string, body: unknown) =>
  auth.handler(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** The reset link mailed to an address, once it has been sent. */
async function mailed(to: string): Promise<string> {
  for (let i = 0; i < 40 && !sent.some((m) => m.to === to); i++) await new Promise((r) => setTimeout(r, 50));
  const link = sent.filter((m) => m.to === to).at(-1)?.text.match(/https?:\/\/\S+/g)?.find((u) => u.includes("/reset-password?"));
  if (!link) throw new Error("no reset link was mailed");
  return link;
}

describe("where a reset link lands", () => {
  it.each([
    ["the page the form asks for", "/reset-password"],
    ["another page of the app", "/rank?run=1"],
    ["a path that leaves for another service", "/ingest/static/x.html?a=1"],
    ["a full address on this origin", `${ORIGIN}/pricing`],
    ["nothing", undefined],
  ])("is the reset page when the request asks for %s", async (_what, redirectTo) => {
    const user = await account();
    const res = await post("/request-password-reset", { email: user.email, ...(redirectTo === undefined ? {} : { redirectTo }) });
    expect(res.status).toBe(200);

    const link = new URL(await mailed(user.email));
    expect(link.origin).toBe(new URL(ORIGIN).origin);
    expect(link.pathname).toBe("/reset-password");
    expect([...link.searchParams.keys()]).toEqual(["token"]);
    expect(await resetTokenUsable(link.searchParams.get("token")!)).toBe(true);
  });

  it("still takes a link in Better Auth's old shape, mailed before the change", async () => {
    const user = await account();
    await post("/request-password-reset", { email: user.email });
    const token = new URL(await mailed(user.email)).searchParams.get("token")!;
    const old = `${ORIGIN}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent("/reset-password")}`;
    const opened = await auth.handler(new Request(old, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } }));
    expect(opened.status).toBe(302);
    const landing = new URL(opened.headers.get("location")!, ORIGIN);
    expect(landing.origin).toBe(new URL(ORIGIN).origin);
    expect(landing.pathname).toBe("/reset-password");
    expect(landing.searchParams.get("token")).toBe(token);
  });

  it("still sets the password from the link", async () => {
    const user = await account();
    await post("/request-password-reset", { email: user.email, redirectTo: "/reset-password" });
    const token = new URL(await mailed(user.email)).searchParams.get("token")!;
    const newPassword = `new-${randomUUID()}`;
    expect((await post("/reset-password", { newPassword, token })).status).toBe(200);
    expect((await post("/sign-in/email", { email: user.email, password: newPassword })).status).toBe(200);
    // Used once, the page shows it as gone rather than a form that would fail.
    expect(await resetTokenUsable(token)).toBe(false);
  });

  it("calls a token usable only while its row is there and in date", async () => {
    const user = await account();
    await post("/request-password-reset", { email: user.email });
    const token = new URL(await mailed(user.email)).searchParams.get("token")!;
    expect(await resetTokenUsable(token)).toBe(true);
    expect(await resetTokenUsable(token, new Date(Date.now() + 2 * 3600_000))).toBe(false);
    expect(await resetTokenUsable(`not-${token}`)).toBe(false);
  });
});
