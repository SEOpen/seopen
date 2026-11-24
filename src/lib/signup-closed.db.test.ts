import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/**
 * Public sign-up with SEOPEN_SIGNUP_OPEN unset, as production runs today, against seopen_test:
 * nothing changes. /sign-up is the beta's waitlist note to the byte, email and Google sign-up refuse
 * new accounts, no hook makes a workspace or claims an inbox, and invites work as before.
 * signup.db.test.ts covers the switch on.
 */

vi.stubEnv("SEOPEN_SIGNUP_OPEN", "");
// The hosted service's pages, which link to its waitlist (src/lib/hosts.ts, siteLinks).
vi.stubEnv("SEOPEN_HAS_SITE", "1");
vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; subject: string; text: string }) => void sent.push(msg),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }), headers: async () => new Headers() }));
vi.mock("@/lib/auth/client", () => ({ authClient: {} }));

const ready = await testDb();

const { db } = await import("@/db");
const { signupClaims, users, workspaceMembers } = await import("@/db/schema");
const { auth } = await import("@/lib/auth");
const { createInvitedAccount, ensureWorkspace } = await import("./invites");
const { openFreeWorkspace, purgeStaleUnconfirmed, refuseTakenInbox } = await import("./signup");
const { handleOAuthUserInfo } = await import("better-auth/oauth2");
const SignUpPage = (await import("@/app/(auth)/sign-up/page")).default;
const SignInPage = (await import("@/app/(auth)/sign-in/page")).default;
const VerifyEmailPage = (await import("@/app/(auth)/verify-email/page")).default;

const PASSWORD = "correct-horse-battery";
const tag = () => randomUUID().slice(0, 8);
const userBy = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0];
const membershipsOf = async (userId: string) => db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
const claimsOf = async (userId: string) => db.select().from(signupClaims).where(eq(signupClaims.userId, userId));
const render = async (page: (p: never) => Promise<React.ReactElement>, sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await page({ searchParams: Promise.resolve(sp) } as never)).replace(/&#x27;/g, "'");

/** The page as it rendered before sign-up could open (366e3ab), byte for byte, with what a new account starts on where this copy has plans. */
const WAITLIST_LINE = rules.newAccountLine("waitlist");
const BETA_NOTE = `<section class="panel"><div class="p-4 flex flex-col gap-3"><h1 class="text-base font-medium">SEOpen is in private beta</h1><p class="text-sm text-muted">Invites go out in batches. <a class="underline" href="/landing#waitlist">Join the waitlist</a> and we&#x27;ll email you when yours is ready.${WAITLIST_LINE ? ` ${WAITLIST_LINE.replace(/'/g, "&#x27;")}` : ""}</p><p class="text-sm text-muted">Got an invite? Use the button in the email to choose your password.</p><a class="text-sm underline" href="/sign-in">Already have an account? Sign in</a></div></section>`;

describe.skipIf(!ready)("public sign-up, switched off", () => {
  beforeEach(() => void (sent.length = 0));

  it("keeps /sign-up the waitlist note, whatever the URL says", async () => {
    expect(renderToStaticMarkup(await SignUpPage({ searchParams: Promise.resolve({}) } as never))).toBe(BETA_NOTE);
    expect(renderToStaticMarkup(await SignUpPage({ searchParams: Promise.resolve({ error: "inbox_taken" }) } as never))).toBe(BETA_NOTE);
  });

  it("keeps the sign-in and confirmation pages' error messages as they were", async () => {
    expect(await render(SignInPage as never, { error: "inbox_taken" })).toContain("Google sign-in didn't work. Try your email and password.");
    expect(await render(SignInPage as never, { error: "signup_disabled" })).toContain("That Google account isn't linked to a SEOpen account.");
    expect(await render(SignInPage as never)).toContain("It's in private beta.");
    expect(await render(VerifyEmailPage as never, { error: "inbox_taken" })).toContain("That link has expired or was already used.");
  });

  it("closes email and Google sign-up", async () => {
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
    const ctx = await auth.$context;
    expect(ctx.socialProviders.find((p) => p.id === "google")?.options?.disableSignUp).toBe(true);
  });

  it("refuses an email sign-up and makes no account", async () => {
    const email = `closed-${tag()}@example.com`;
    await expect(auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "" } })).rejects.toMatchObject({ body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" } });
    expect(await userBy(email)).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("refuses a new Google account, as now, and makes nothing", async () => {
    const email = `closed-google-${tag()}@example.com`;
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

  it("makes no workspace and claims no inbox for a verified account, however it signs in", async () => {
    // An account made outside sign-up, confirming its address and signing in.
    const email = `closed-verify-${tag()}@example.com`;
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified: false }, { method: "admin" });
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
    await auth.api.sendVerificationEmail({ body: { email } });
    const token = sent.find((m) => m.to === email)?.text.match(/verify-email\?token=([\w.-]+)/)?.[1];
    const opened = await auth.api.verifyEmail({ query: { token: token! }, asResponse: true });
    // The link clears the password and ends other sessions even with sign-up closed, so a sign-up
    // made while it was open and confirmed after it closed is just as safe. Production has no
    // unconfirmed accounts while closed, so this changes nothing there.
    await expect(auth.api.signInEmail({ body: { email, password: PASSWORD } })).rejects.toMatchObject({ body: { code: "INVALID_EMAIL_OR_PASSWORD" } });
    const cookie = opened.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    await auth.api.setPassword({ body: { newPassword: PASSWORD }, headers: new Headers({ cookie }) });
    await auth.api.signInEmail({ body: { email, password: PASSWORD } });
    expect((await userBy(email)).emailVerified).toBe(true);
    expect(await membershipsOf(user.id)).toHaveLength(0);
    expect(await claimsOf(user.id)).toHaveLength(0);
    expect(await openFreeWorkspace(user.id)).toBe("closed");
    await expect(refuseTakenInbox(email, "/sign-up/email", async () => {})).resolves.toBeUndefined();
  });

  it("never deletes an unconfirmed account, however old", async () => {
    const email = `closed-stale-${tag()}@example.com`;
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified: false }, { method: "admin" });
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: "x" });
    await db.update(users).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(users.id, user.id));
    expect(await purgeStaleUnconfirmed(email)).toBe(0);
    // Google's profile step and an email sign-up attempt, the two places it would run.
    const google = ctx.socialProviders.find((p) => p.id === "google")!;
    const claims = { sub: `sub-${tag()}`, email, email_verified: true, aud: "test-client-id" };
    const idToken = [{ alg: "none", typ: "JWT" }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).join(".") + ".";
    await google.getUserInfo({ idToken });
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "" } }).catch(() => {});
    expect((await userBy(email))?.id).toBe(user.id);
  });

  it("leaves invites as they were", async () => {
    const email = `closed-invitee-${tag()}@example.com`;
    const userId = await createInvitedAccount(email);
    expect(await ensureWorkspace(userId, email)).toBe(true);
    expect(await ensureWorkspace(userId, email)).toBe(false);
    expect(await membershipsOf(userId)).toHaveLength(1);
    expect(await claimsOf(userId)).toHaveLength(0);
  });
});
