import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A copy without public sign-up, as this repo is, against seopen_test. Every setting an older version
 * read is on, and nothing opens: email and Google make no accounts, and the sign-up and confirmation
 * endpoints don't answer. Accounts an operator makes still sign in. The parts are named here rather
 * than taken from `@/public-signup`, so this tests the same thing where a hosted service adds its own.
 */

vi.stubEnv("SEOPEN_SIGNUP_OPEN", "1");
vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("server-only", () => ({}));
vi.mock("@/public-signup/server", () => import("./none/server"));
vi.mock("@/public-signup/page", () => import("./none/page"));
vi.mock("@/public-signup/client", () => import("./none/client"));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; subject: string; text: string }) => void sent.push(msg),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/auth/client", () => ({ authClient: {} }));

const ready = await testDb();

const { db } = await import("@/db");
const { sessions, users, workspaceMembers } = await import("@/db/schema");
const { auth } = await import("@/lib/auth");
const { POST, GET } = await import("@/app/api/auth/[...all]/route");
const { createInvitedAccount, ensureWorkspace } = await import("@/lib/invites");
const { handleOAuthUserInfo } = await import("better-auth/oauth2");
const SignInPage = (await import("@/app/(auth)/sign-in/page")).default;

const PASSWORD = "correct-horse-battery";
const tag = () => randomUUID().slice(0, 8);
const userBy = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0];
const base = auth.options.baseURL as string;
const post = (path: string, body: unknown) =>
  POST(new Request(`${base}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) }));

describe.skipIf(!ready)("a copy without public sign-up", () => {
  beforeEach(() => void (sent.length = 0));

  it("closes email and Google sign-up, whatever SEOPEN_SIGNUP_OPEN says", async () => {
    expect(auth.options.emailAndPassword.disableSignUp).toBe(true);
    const ctx = await auth.$context;
    expect(ctx.socialProviders.find((p) => p.id === "google")?.options?.disableSignUp).toBe(true);
  });

  it("doesn't answer the sign-up and confirmation endpoints, and makes no account", async () => {
    const email = `none-${tag()}@example.com`;
    expect((await post("/sign-up/email", { email, password: PASSWORD, name: "" })).status).toBe(404);
    expect((await post("/send-verification-email", { email })).status).toBe(404);
    expect((await GET(new Request(`${base}/api/auth/verify-email?token=x`))).status).toBe(404);
    expect(await userBy(email)).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("refuses a sign-up called inside the server too", async () => {
    const email = `none-api-${tag()}@example.com`;
    await expect(auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "" } })).rejects.toMatchObject({ body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" } });
    expect(await userBy(email)).toBeUndefined();
  });

  it("refuses a new Google account and makes nothing", async () => {
    const email = `none-google-${tag()}@example.com`;
    const ctx = await auth.$context;
    const result = await handleOAuthUserInfo({ context: ctx } as never, {
      userInfo: { id: `sub-${tag()}`, email, emailVerified: true, name: "Pat" },
      account: { providerId: "google", accountId: `sub-${tag()}` },
      callbackURL: "/",
      disableSignUp: ctx.socialProviders.find((p) => p.id === "google")?.options?.disableSignUp,
    });
    expect(result.error).toBe("signup disabled");
    expect(await userBy(email)).toBeUndefined();
  });

  it("still lets an account an operator made sign in, with its own workspace", async () => {
    const email = `none-made-${tag()}@example.com`;
    const id = await createInvitedAccount(email);
    expect(await ensureWorkspace(id, email)).toBe(true);
    const ctx = await auth.$context;
    await ctx.internalAdapter.linkAccount({ userId: id, providerId: "credential", accountId: id, password: await ctx.password.hash(PASSWORD) });
    expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(1);
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, id))).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("keeps an account nobody confirmed out, and sends it nothing", async () => {
    const email = `none-unconfirmed-${tag()}@example.com`;
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified: false }, { method: "admin" });
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
    const res = await post("/sign-in/email", { email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(sent).toHaveLength(0);
  });

  it("offers no way to sign up on the sign-in page", async () => {
    // The page is a Suspense boundary around the card that reads the query: render that card.
    type Element = { props: { children: { type: (props: object) => Promise<React.ReactElement>; props: object } } };
    const card = (SignInPage({ searchParams: Promise.resolve({}) } as never) as unknown as Element).props.children;
    const html = renderToStaticMarkup(await card.type(card.props));
    expect(html).toContain("Accounts are made by whoever runs this copy of SEOpen.");
    expect(html).not.toMatch(/sign-up|waitlist|beta/);
  });
});
