import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Public sign-up with SEOPEN_SIGNUP_OPEN=1, against seopen_test, through real Better Auth calls:
 * sign up, confirm, land in a Free workspace; one account per inbox; a double confirmation makes one
 * workspace; invites are unaffected. Email is captured, so nothing reaches Resend.
 * signup-closed.db.test.ts covers the switch off.
 */

vi.stubEnv("SEOPEN_SIGNUP_OPEN", "1");
vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
// Addresses whose email fails to send, for the test that a failure is logged.
const failing = vi.hoisted(() => new Set<string>());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; subject: string; text: string }) => {
    if (failing.has(msg.to)) throw new Error("Resend is down");
    sent.push(msg);
  },
}));
// Next's after(). Outside a request it throws, as the real one does, so emails send at once; a test
// that sets `inRequest` gets the request's after() instead, and runs the queue as the response ends.
const afterResponse = vi.hoisted(() => ({ inRequest: false, queue: [] as (() => unknown)[] }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    if (!afterResponse.inRequest) throw new Error("`after` was called outside a request scope.");
    afterResponse.queue.push(task);
  },
}));
/** Ends the response: runs what after() queued. */
async function endResponse() {
  const tasks = afterResponse.queue.splice(0);
  await Promise.all(tasks.map((t) => t()));
}
// The request's headers: a test sets them to a browser's session cookie for the Server Action and the page.
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }), headers: async () => request.headers }));

const ready = await testDb();

const { db } = await import("@/db");
const { accounts, sessions, signupClaims, users, workspaceMembers, workspaces } = await import("@/db/schema");
const { auth } = await import("@/lib/auth");
const { normalizeEmail } = await import("@/lib/email-address");
const { createInvitedAccount, ensureWorkspace } = await import("./invites");
const { FREE_RESIGNUP_DAYS, UNCONFIRMED_KEEP_DAYS, inboxHash, inboxRefusal, inboxSql, openFreeWorkspace, purgeStaleUnconfirmed, purgeUnconfirmedSignups, refuseTakenInbox } = await import("./signup");
const { handleOAuthUserInfo } = await import("better-auth/oauth2");
const { setFirstPassword } = await import("@/app/actions/auth");
const { default: SetPasswordPage } = await import("@/app/(auth)/set-password/page");
const { renderToStaticMarkup } = await import("react-dom/server");

const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "chosen-after-the-link";
const tag = () => randomUUID().slice(0, 8);

const signUp = (email: string) => auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "" } });

/** The token from the last confirmation email to this address. */
function tokenFor(email: string): string {
  const mail = sent.filter((m) => m.to === email && m.subject === "Confirm your SEOpen email").at(-1);
  const token = mail?.text.match(/verify-email\?token=([\w.-]+)/)?.[1];
  if (!token) throw new Error(`no confirmation email for ${email}`);
  return token;
}

/** The whole link from the last confirmation email to this address. */
function linkFor(email: string): URL {
  const mail = sent.filter((m) => m.to === email && m.subject === "Confirm your SEOpen email").at(-1);
  const link = mail?.text.match(/(https?:\/\/\S+\/verify-email\?\S+)/)?.[1];
  if (!link) throw new Error(`no confirmation email for ${email}`);
  return new URL(link);
}

/** Opens the emailed link as a browser does: where it sends you, and the session cookie it sets. */
async function openLink(email: string): Promise<{ location: string; cookie: string }> {
  const query = Object.fromEntries(linkFor(email).searchParams) as { token: string; callbackURL?: string };
  const res = await auth.api.verifyEmail({ query, asResponse: true });
  return { location: res.headers.get("location") ?? "", cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

/** Whether this address and password sign in. */
const signsIn = (email: string, password: string) =>
  auth.api.signInEmail({ body: { email, password } }).then(
    () => true,
    (err: { body?: { code?: string } }) => {
      if (err.body?.code === "INVALID_EMAIL_OR_PASSWORD") return false;
      throw err;
    },
  );

/** Opens the confirmation link. A refusal comes back as a redirect to /verify-email?error=…. */
async function confirm(email: string): Promise<{ ok: true } | { ok: false; location: string }> {
  try {
    await auth.api.verifyEmail({ query: { token: tokenFor(email) } });
    return { ok: true };
  } catch (err) {
    const e = err as { statusCode?: number; headers?: Headers };
    if (e.statusCode === 302 && e.headers) return { ok: false, location: new Headers(e.headers).get("location") ?? "" };
    throw err;
  }
}

const userBy = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0];
const workspacesOf = async (userId: string) =>
  db.select({ ws: workspaces, role: workspaceMembers.role }).from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId)).where(eq(workspaceMembers.userId, userId));
const claimOf = async (email: string) => (await db.select().from(signupClaims).where(eq(signupClaims.hash, inboxHash(normalizeEmail(email)!))))[0];

describe.skipIf(!ready)("public sign-up, switched on", () => {
  beforeEach(() => void (sent.length = 0));

  it("opens email and Google sign-up together", async () => {
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(false);
    const ctx = await auth.$context;
    expect(ctx.socialProviders.find((p) => p.id === "google")?.options?.disableSignUp).toBe(false);
  });

  it("normalizes stored addresses in SQL exactly as normalizeEmail does", async () => {
    const samples = ["A.B.C@Gmail.com", "abc+news@googlemail.com", "a.b+x+y@gmail.com", "First.Last+tag@example.co.uk", "plain@example.com", " spaced@Example.com "];
    for (const s of samples) {
      const [row] = await db.execute<{ inbox: string }>(sql`select ${inboxSql(sql`${s}::text`)} as inbox`);
      expect(row.inbox).toBe(normalizeEmail(s));
    }
  });

  it("signs up, confirms and lands in a Free workspace, and an unconfirmed account owns nothing", async () => {
    const email = `new-${tag()}@example.com`;
    await signUp(email);
    const before = await userBy(email);
    expect(before.emailVerified).toBe(false);
    expect(await workspacesOf(before.id)).toHaveLength(0);
    expect(await claimOf(email)).toBeUndefined();

    expect(await confirm(email)).toEqual({ ok: true });
    const after = await userBy(email);
    expect(after.emailVerified).toBe(true);
    const owned = await workspacesOf(after.id);
    expect(owned).toHaveLength(1);
    expect(owned[0].ws.plan).toBe("free");
    expect(owned[0].role).toBe("owner");
    expect((await claimOf(email))?.userId).toBe(after.id);

    // The link cleared the password typed at sign-up. With a new one chosen, it signs in and stays
    // in its one workspace.
    expect(await signsIn(email, PASSWORD)).toBe(false);
    const ctx = await auth.$context;
    await ctx.internalAdapter.updatePassword(after.id, await ctx.password.hash(NEW_PASSWORD));
    expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
    expect(await workspacesOf(after.id)).toHaveLength(1);
  });

  it("refuses a second account for the same inbox, Gmail dots and +tags included, and tells the inbox", async () => {
    const local = `dots${tag()}`;
    const first = `${local.slice(0, 3)}.${local.slice(3)}@gmail.com`;
    await signUp(first);
    await confirm(first);

    for (const alias of [`${local}@gmail.com`, `${local}+second@googlemail.com`, `${local.toUpperCase()}@GMAIL.com`]) {
      sent.length = 0;
      // The same answer as a new address, so the form can't be used to find accounts.
      const res = await signUp(alias);
      expect(res.token).toBeNull();
      expect(await userBy(alias.toLowerCase())).toBeUndefined();
      expect(sent.filter((m) => m.to === alias.toLowerCase()).map((m) => m.subject)).toEqual(["You already have a SEOpen account"]);
    }

    const work = `pat${tag()}@example.com`;
    await signUp(work);
    await confirm(work);
    await signUp(work.replace("@", "+side@"));
    expect(await userBy(work.replace("@", "+side@"))).toBeUndefined();

    // Signing up again with the very same address makes nothing either, and says so to the inbox.
    sent.length = 0;
    await signUp(work);
    expect(sent.filter((m) => m.to === work).map((m) => m.subject)).toEqual(["You already have a SEOpen account"]);
  });

  it("lets an unconfirmed alias through, but only the first of two to confirm gets the inbox", async () => {
    const local = `race${tag()}`;
    const a = `${local}@gmail.com`;
    const b = `${local.slice(0, 2)}.${local.slice(2)}@gmail.com`;
    await signUp(a);
    await signUp(b);
    expect(await userBy(b)).toBeDefined();

    const results = await Promise.all([confirm(a), confirm(b)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok) as { location: string };
    expect(loser.location).toMatch(/\/verify-email\?error=inbox_taken$/);

    const [ua, ub] = await Promise.all([userBy(a), userBy(b)]);
    expect([ua.emailVerified, ub.emailVerified].filter(Boolean)).toHaveLength(1);
    const owned = [...(await workspacesOf(ua.id)), ...(await workspacesOf(ub.id))];
    expect(owned).toHaveLength(1);
  });

  it("makes one workspace when the link is opened twice at once, or the hooks race", async () => {
    const email = `twice-${tag()}@example.com`;
    await signUp(email);
    await Promise.all([confirm(email), confirm(email), confirm(email)]);
    const user = await userBy(email);
    expect(await workspacesOf(user.id)).toHaveLength(1);

    const other = `race-${tag()}@example.com`;
    await signUp(other);
    const u = await userBy(other);
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, u.id));
    const results = await Promise.all(Array.from({ length: 8 }, () => openFreeWorkspace(u.id)));
    expect(results.filter((r) => r === "made")).toHaveLength(1);
    expect(await workspacesOf(u.id)).toHaveLength(1);
    expect(await Promise.all(Array.from({ length: 5 }, () => ensureWorkspace(u.id, other)))).toEqual([false, false, false, false, false]);
    expect(await workspacesOf(u.id)).toHaveLength(1);
  });

  it("gives a Google sign-up, which arrives verified, its Free workspace on its first session", async () => {
    const email = `google-${tag()}@example.com`;
    const ctx = await auth.$context;
    const c = { context: ctx, request: undefined, headers: new Headers(), setCookie: () => {}, getCookie: () => null, getSignedCookie: async () => null, setSignedCookie: async () => {} } as never;
    const result = await handleOAuthUserInfo(c, {
      userInfo: { id: `sub-${tag()}`, email, emailVerified: true, name: "Pat" },
      account: { providerId: "google", accountId: `sub-${tag()}` },
      callbackURL: "/",
      disableSignUp: ctx.socialProviders.find((p) => p.id === "google")?.options?.disableSignUp,
    });
    expect(result.error).toBeNull();
    const user = await userBy(email);
    await vi.waitFor(async () => expect(await workspacesOf(user.id)).toHaveLength(1));
    expect((await workspacesOf(user.id))[0].ws.plan).toBe("free");
  });

  it("refuses a Google sign-up for an inbox that has an account, and sends the reason back to the page", async () => {
    const email = `gtaken${tag()}@gmail.com`;
    await signUp(email);
    await confirm(email);
    const notify = vi.fn(async () => {});
    const alias = email.replace("gtaken", "g.taken");
    await expect(refuseTakenInbox(alias, "/callback/:id", notify)).rejects.toMatchObject({ statusCode: 403, body: { code: "inbox_taken" } });
    // A Google ID token posted to /sign-in/social makes an account too, so it's refused the same way.
    await expect(refuseTakenInbox(alias, "/sign-in/social", notify)).rejects.toMatchObject({ statusCode: 403, body: { code: "inbox_taken" } });
    expect(notify).not.toHaveBeenCalled();
    // Invites and admin accounts are made outside any endpoint, and are never refused here.
    await expect(refuseTakenInbox(alias, undefined, notify)).resolves.toBeUndefined();
  });

  it("lets a deleted account's inbox sign up again only a week after the delete", async () => {
    const email = `gone-${tag()}@example.com`;
    await signUp(email);
    await confirm(email);
    const user = await userBy(email);
    // What deleteWorkspaceOp does to the account (src/lib/workspace/delete.ts).
    await db.delete(workspaces).where(inArray(workspaces.id, (await workspacesOf(user.id)).map((w) => w.ws.id)));
    await db.delete(users).where(eq(users.id, user.id));
    await db.update(signupClaims).set({ releasedAt: new Date() }).where(eq(signupClaims.userId, user.id));

    sent.length = 0;
    await signUp(email);
    expect(await userBy(email)).toBeUndefined();
    expect(sent[0]?.subject).toBe("You can make a new SEOpen account soon");

    await db.update(signupClaims).set({ releasedAt: new Date(Date.now() - (FREE_RESIGNUP_DAYS + 1) * 86_400_000) }).where(eq(signupClaims.userId, user.id));
    await signUp(email);
    expect(await confirm(email)).toEqual({ ok: true });
    const back = await userBy(email);
    expect(await workspacesOf(back.id)).toHaveLength(1);
    expect((await claimOf(email))?.userId).toBe(back.id);
  });

  it("starts an invited workspace on internal with SEOPEN_NEW_WORKSPACES_INTERNAL=1, and keeps a self sign-up on Free", async () => {
    vi.stubEnv("SEOPEN_NEW_WORKSPACES_INTERNAL", "1");
    try {
      const plansOf = async (userId: string) =>
        (await db.select({ plan: workspaces.plan }).from(workspaces).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, userId))).map((r) => r.plan);
      const invited = `internal-${tag()}@example.com`;
      const invitedId = await createInvitedAccount(invited);
      expect(await ensureWorkspace(invitedId, invited)).toBe(true);
      expect(await plansOf(invitedId)).toEqual(["internal"]);

      const email = `self-${tag()}@example.com`;
      await signUp(email);
      expect(await confirm(email)).toEqual({ ok: true });
      expect(await plansOf((await userBy(email)).id)).toEqual(["free"]);
    } finally {
      vi.stubEnv("SEOPEN_NEW_WORKSPACES_INTERNAL", "");
    }
  });

  it("leaves an invited account as it was: one workspace from the invite, no inbox claim", async () => {
    // The invite's own steps (inviteFromWaitlist), without a waitlist row: invites.db.test.ts counts those.
    const email = `invitee-${tag()}@example.com`;
    const userId = await createInvitedAccount(email);
    expect(await ensureWorkspace(userId, email)).toBe(true);
    const user = await userBy(email);
    expect(user.emailVerified).toBe(true);
    expect(await workspacesOf(userId)).toHaveLength(1);

    // The invitee chooses a password and signs in.
    const ctx = await auth.$context;
    await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: await ctx.password.hash(PASSWORD) });
    await auth.api.signInEmail({ body: { email, password: PASSWORD } });
    expect(await openFreeWorkspace(userId)).toBe("member");
    expect(await workspacesOf(userId)).toHaveLength(1);
    expect(await claimOf(email)).toBeUndefined();

    // And a self sign-up at the invitee's inbox is refused like any other.
    await signUp(email.replace("@", "+again@"));
    expect(await userBy(email.replace("@", "+again@"))).toBeUndefined();
  });
});

describe.skipIf(!ready)("the confirmation link clears the sign-up's password", () => {
  beforeEach(() => {
    sent.length = 0;
    request.headers = new Headers();
  });

  it("locks out someone who signed up with another person's address, once that person opens the link", async () => {
    const victim = `victim-${tag()}@example.com`;
    // The attacker signs up with the victim's address and a password of their own.
    await auth.api.signUpEmail({ body: { email: victim, password: "attackers-own-password", name: "" } });
    const user = await userBy(victim);
    // Any session the account already has, however it got one, belongs to whoever knew the password.
    const ctx = await auth.$context;
    const attackers = await ctx.internalAdapter.createSession(user.id);

    // The victim opens the link that reached their inbox.
    const { location, cookie } = await openLink(victim);
    expect(location).toMatch(/\/set-password$/);
    expect(cookie).toContain("session_token=");

    expect((await userBy(victim)).emailVerified).toBe(true);
    expect(await signsIn(victim, "attackers-own-password")).toBe(false);
    const [credential] = await db.select().from(accounts).where(eq(accounts.userId, user.id));
    expect(credential.password).toBeNull();
    const left = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(left.map((s) => s.id)).not.toContain(attackers.id);
    // The one session left is the victim's, from the link.
    expect(left).toHaveLength(1);
    const victims = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(victims?.session.id).toBe(left[0].id);
  });

  it("sends the link to /set-password, keeping where the person was going", async () => {
    const email = `next-${tag()}@example.com`;
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "", callbackURL: "/rank" } });
    expect(linkFor(email).searchParams.get("callbackURL")).toBe("/set-password?next=%2Frank");
    // A callback that isn't one of our pages goes to the dashboard instead.
    const plain = `plain-${tag()}@example.com`;
    await signUp(plain);
    expect(linkFor(plain).searchParams.get("callbackURL")).toBe("/set-password");
  });

  it("takes an honest sign-up from the link to its password to the app, one step longer than before", async () => {
    const email = `honest-${tag()}@example.com`;
    await signUp(email);
    const { location, cookie } = await openLink(email);
    expect(location).toMatch(/\/set-password$/);
    const user = await userBy(email);
    expect(await workspacesOf(user.id)).toHaveLength(1);

    // The page asks for a password, and says why in plain words.
    request.headers = new Headers({ cookie });
    const html = renderToStaticMarkup(await SetPasswordPage({ searchParams: Promise.resolve({}) } as never)).replace(/&#x27;/g, "'");
    expect(html).toContain("Choose your password");
    expect(html).toContain("only the person who opens the confirmation email");

    // Two passwords that differ are sent back; matching ones are saved and the person goes on to the app.
    const form = (password: string, confirm = password) => {
      const f = new FormData();
      f.set("password", password);
      f.set("confirm", confirm);
      f.set("next", "/");
      return f;
    };
    expect(await setFirstPassword(null, form(NEW_PASSWORD, "something-else"))).toEqual({ error: "The two passwords don't match." });
    expect(await setFirstPassword(null, form("short"))).toEqual({ error: expect.stringContaining("8 characters") });
    await expect(setFirstPassword(null, form(NEW_PASSWORD))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT;replace;/;") });
    expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
    expect(await signsIn(email, PASSWORD)).toBe(false);

    // With a password set, the page sends the person on, and a second save changes nothing.
    await expect(SetPasswordPage({ searchParams: Promise.resolve({ next: "/rank" }) } as never)).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT;replace;/rank;") });
    await expect(setFirstPassword(null, form("yet-another-password"))).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
  });

  it("sends a failed link to the confirmation page, and a visitor with no session to sign in", async () => {
    await expect(SetPasswordPage({ searchParams: Promise.resolve({ error: "TOKEN_EXPIRED" }) } as never)).rejects.toMatchObject({ digest: expect.stringContaining("/verify-email?error=TOKEN_EXPIRED;") });
    await expect(SetPasswordPage({ searchParams: Promise.resolve({}) } as never)).rejects.toMatchObject({ digest: expect.stringContaining("/sign-in;") });
  });

  it("leaves a confirmed account's password alone when its old link is opened again", async () => {
    const email = `reopen-${tag()}@example.com`;
    await signUp(email);
    await openLink(email);
    const user = await userBy(email);
    const ctx = await auth.$context;
    await ctx.internalAdapter.updatePassword(user.id, await ctx.password.hash(NEW_PASSWORD));
    await openLink(email);
    expect(await signsIn(email, NEW_PASSWORD)).toBe(true);
  });
});

/** An unsigned Google ID token: the provider's getUserInfo only decodes it (the callback has already checked it with Google). */
const googleIdToken = (claims: Record<string, unknown>) =>
  ["none", claims].map((part) => Buffer.from(JSON.stringify(part === "none" ? { alg: "none", typ: "JWT" } : part)).toString("base64url")).join(".") + ".";

/** Google sign-in for `email` as the callback runs it: the provider reads the profile, then Better Auth finds or makes the account. */
async function googleSignIn(email: string) {
  const ctx = await auth.$context;
  const google = ctx.socialProviders.find((p) => p.id === "google")!;
  const sub = `sub-${tag()}`;
  const info = await google.getUserInfo({ idToken: googleIdToken({ sub, email, email_verified: true, name: "Pat", aud: "test-client-id", iss: "https://accounts.google.com" }) });
  const c = { context: ctx, request: undefined, headers: new Headers(), setCookie: () => {}, getCookie: () => null, getSignedCookie: async () => null, setSignedCookie: async () => {} } as never;
  return handleOAuthUserInfo(c, {
    userInfo: { ...info!.user, id: sub, email, emailVerified: true, name: "Pat" },
    account: { providerId: "google", accountId: sub },
    callbackURL: "/",
    disableSignUp: google.options?.disableSignUp,
  });
}

/** Moves an account's creation back past the confirmation link's 24 hours. */
const age = (userId: string, hours = 25) => db.update(users).set({ createdAt: new Date(Date.now() - hours * 3_600_000) }).where(eq(users.id, userId));

describe.skipIf(!ready)("stale unconfirmed sign-ups, switched on", () => {
  beforeEach(() => void (sent.length = 0));

  it("don't block the inbox's owner from Google once their link has expired", async () => {
    const email = `squat-${tag()}@example.com`;
    await signUp(email);
    const squatter = await userBy(email);
    await age(squatter.id);

    const result = await googleSignIn(email);
    expect(result.error).toBeNull();
    const owner = await userBy(email);
    expect(owner.id).not.toBe(squatter.id);
    expect(owner.emailVerified).toBe(true);
    await vi.waitFor(async () => expect(await workspacesOf(owner.id)).toHaveLength(1));
  });

  it("don't block a fresh email sign-up for the same address once their link has expired", async () => {
    const email = `again-${tag()}@example.com`;
    await signUp(email);
    const first = await userBy(email);
    await age(first.id);

    sent.length = 0;
    await signUp(email);
    const second = await userBy(email);
    expect(second.id).not.toBe(first.id);
    expect(sent.filter((m) => m.to === email).map((m) => m.subject)).toEqual(["Confirm your SEOpen email"]);
    expect(await confirm(email)).toEqual({ ok: true });
  });

  it("give way to Google at once, however fresh, but make an email sign-up wait for the link", async () => {
    const email = `fresh-${tag()}@example.com`;
    await signUp(email);
    const squatter = await userBy(email);

    // A second email sign-up within the day is a duplicate: the first may be the owner's own.
    sent.length = 0;
    await signUp(email);
    expect((await userBy(email)).id).toBe(squatter.id);
    expect(sent.filter((m) => m.to === email)).toHaveLength(0);

    // Google vouching for the address is the owner arriving, so the unconfirmed account goes now.
    const result = await googleSignIn(email);
    expect(result.error).toBeNull();
    const owner = await userBy(email);
    expect(owner.id).not.toBe(squatter.id);
    expect(owner.emailVerified).toBe(true);
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, squatter.id))).toHaveLength(0);
    await vi.waitFor(async () => expect(await workspacesOf(owner.id)).toHaveLength(1));
  });

  it("free an inbox whose confirmation failed after the claim: for Google at once, for email after the day", async () => {
    const ctx = await auth.$context;
    /** Signs up and opens the link, with the step after the inbox claim failing. */
    const stuck = async (email: string) => {
      await signUp(email);
      const fail = vi.spyOn(ctx.internalAdapter, "deleteUserSessions").mockRejectedValueOnce(new Error("database went away"));
      try {
        await expect(confirm(email)).rejects.toBeDefined();
      } finally {
        fail.mockRestore();
      }
      const user = await userBy(email);
      expect(user.emailVerified).toBe(false);
      expect((await claimOf(email))?.userId).toBe(user.id);
      expect(await inboxRefusal(email)).toEqual({ kind: "taken" });
      return user;
    };

    const viaGoogle = `stuck-google-${tag()}@example.com`;
    const first = await stuck(viaGoogle);
    expect((await googleSignIn(viaGoogle)).error).toBeNull();
    const owner = await userBy(viaGoogle);
    expect(owner.id).not.toBe(first.id);
    await vi.waitFor(async () => expect(await workspacesOf(owner.id)).toHaveLength(1));
    expect((await claimOf(viaGoogle))?.userId).toBe(owner.id);

    const viaEmail = `stuck-email-${tag()}@example.com`;
    const second = await stuck(viaEmail);
    await age(second.id);
    await signUp(viaEmail);
    const again = await userBy(viaEmail);
    expect(again.id).not.toBe(second.id);
    expect(await claimOf(viaEmail)).toBeUndefined();
    expect(await confirm(viaEmail)).toEqual({ ok: true });
    expect((await claimOf(viaEmail))?.userId).toBe(again.id);
    expect(await workspacesOf(again.id)).toHaveLength(1);
  });

  it("keep a deleted account's released claim, so its week's wait survives the purge", async () => {
    const email = `released-${tag()}@example.com`;
    const hash = inboxHash(normalizeEmail(email)!);
    await db.insert(signupClaims).values({ hash, userId: `deleted-${tag()}`, releasedAt: new Date() });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified: false }, { method: "admin" });
    await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: "x" });
    await age(user.id);

    expect(await purgeStaleUnconfirmed(email)).toBe(1);
    const [claim] = await db.select().from(signupClaims).where(eq(signupClaims.hash, hash));
    expect(claim.releasedAt).not.toBeNull();
    sent.length = 0;
    await signUp(email);
    expect(await userBy(email)).toBeUndefined();
    expect(sent.map((m) => m.subject)).toEqual(["You can make a new SEOpen account soon"]);
  });

  it("never touch a confirmed, invited, workspace-owning, Google-linked or still-fresh account", async () => {
    const ctx = await auth.$context;
    const make = async (label: string, emailVerified: boolean) => {
      const email = `keep-${label}-${tag()}@example.com`;
      const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified }, { method: "admin" });
      return { id: user.id, email };
    };
    const credential = (userId: string) => ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: "x" });

    const verified = await make("verified", true);
    await credential(verified.id);
    const verifiedClaim = `test-${tag()}`;
    await db.insert(signupClaims).values({ hash: verifiedClaim, userId: verified.id });
    const invitedEmail = `keep-invited-${tag()}@example.com`;
    const invited = { id: await createInvitedAccount(invitedEmail), email: invitedEmail };
    await ensureWorkspace(invited.id, invited.email);
    const member = await make("member", false);
    await credential(member.id);
    await ensureWorkspace(member.id, member.email);
    const linked = await make("linked", false);
    await credential(linked.id);
    await ctx.internalAdapter.linkAccount({ userId: linked.id, providerId: "google", accountId: `sub-${tag()}` });
    const old = [verified, invited, member, linked];
    for (const u of old) await age(u.id, 24 * 30);

    // The same rules hold at any age when Google vouches: only the age rule is waived.
    const freshVerified = await make("fresh-verified", true);
    await credential(freshVerified.id);
    const freshMember = await make("fresh-member", false);
    await credential(freshMember.id);
    await ensureWorkspace(freshMember.id, freshMember.email);
    for (const u of [...old, freshVerified, freshMember]) {
      await googleSignIn(u.email);
      await signUp(u.email);
    }

    // And an email sign-up alone never replaces one still inside its link's day.
    const fresh = await make("fresh", false);
    await credential(fresh.id);
    await age(fresh.id, 23);
    await signUp(fresh.email);

    for (const u of [...old, freshVerified, freshMember, fresh]) expect((await db.select({ id: users.id }).from(users).where(eq(users.id, u.id))).length, u.email).toBe(1);
    expect(await db.select().from(signupClaims).where(eq(signupClaims.hash, verifiedClaim))).toHaveLength(1);
  });
});

describe.skipIf(!ready)("the daily sweep of unconfirmed sign-ups", () => {
  it("deletes one past the keep window with its claim, and keeps fresh, confirmed, member and Google-linked accounts", async () => {
    const ctx = await auth.$context;
    const make = async (label: string, emailVerified: boolean) => {
      const email = `sweep-${label}-${tag()}@example.com`;
      const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified }, { method: "admin" });
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: "x" });
      return { id: user.id, email };
    };
    const days = (n: number) => n * 24;

    const stale = await make("stale", false);
    const staleClaim = `test-${tag()}`;
    await db.insert(signupClaims).values({ hash: staleClaim, userId: stale.id });
    await age(stale.id, days(UNCONFIRMED_KEEP_DAYS + 3));
    const fresh = await make("fresh", false);
    await age(fresh.id, days(3));
    const verified = await make("verified", true);
    const member = await make("member", false);
    await ensureWorkspace(member.id, member.email);
    const linked = await make("linked", false);
    await ctx.internalAdapter.linkAccount({ userId: linked.id, providerId: "google", accountId: `sub-${tag()}` });
    for (const u of [verified, member, linked]) await age(u.id, days(30));

    expect(await purgeUnconfirmedSignups()).toBeGreaterThanOrEqual(1);
    const left = async (id: string) => (await db.select({ id: users.id }).from(users).where(eq(users.id, id))).length;
    expect(await left(stale.id)).toBe(0);
    expect(await db.select().from(signupClaims).where(eq(signupClaims.hash, staleClaim))).toHaveLength(0);
    for (const u of [fresh, verified, member, linked]) expect(await left(u.id), u.email).toBe(1);
  });
});

/** Waits for the welcome email a confirmation's first session sends in the background, so it can't land mid-test. */
const welcomed = (email: string) => vi.waitFor(() => expect(sent.some((m) => m.to === email && m.subject === "Welcome to SEOpen")).toBe(true));

describe.skipIf(!ready)("sign-up emails go after the response, switched on", () => {
  beforeEach(() => {
    sent.length = 0;
    failing.clear();
    afterResponse.queue.length = 0;
    afterResponse.inRequest = true;
    return () => void (afterResponse.inRequest = false);
  });

  it("answers a new, a pending, a confirmed and a refused address having sent nothing yet, then sends as before", async () => {
    // Set up outside the request: a pending sign-up, and a confirmed one with a Gmail alias.
    afterResponse.inRequest = false;
    const pending = `pending-${tag()}@example.com`;
    await signUp(pending);
    const local = `timed${tag()}`;
    const confirmed = `${local}@gmail.com`;
    await signUp(confirmed);
    await confirm(confirmed);
    await welcomed(confirmed);
    afterResponse.inRequest = true;
    sent.length = 0;

    const fresh = `fresh-${tag()}@example.com`;
    const alias = `${local.slice(0, 2)}.${local.slice(2)}@gmail.com`;
    for (const email of [fresh, pending, confirmed, alias]) {
      const res = await signUp(email);
      expect(res.token).toBeNull();
      // Whatever the address, nothing has been sent by the time the response is ready.
      expect(sent, email).toHaveLength(0);
    }
    await endResponse();
    const subjects = (email: string) => sent.filter((m) => m.to === email).map((m) => m.subject);
    expect(subjects(fresh)).toEqual(["Confirm your SEOpen email"]);
    expect(subjects(pending)).toEqual([]);
    expect(subjects(confirmed)).toEqual(["You already have a SEOpen account"]);
    expect(subjects(alias)).toEqual(["You already have a SEOpen account"]);
    expect(await userBy(alias)).toBeUndefined();
  });

  it("answers a password reset before its email goes, account or not", async () => {
    afterResponse.inRequest = false;
    const email = `reset-${tag()}@example.com`;
    await signUp(email);
    await confirm(email);
    await welcomed(email);
    afterResponse.inRequest = true;
    sent.length = 0;

    for (const address of [email, `nobody-${tag()}@example.com`]) {
      await auth.api.requestPasswordReset({ body: { email: address, redirectTo: "/reset-password" } });
      expect(sent).toHaveLength(0);
    }
    await endResponse();
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[email, "Reset your SEOpen password"]]);
  });

  it("logs an email that fails to send instead of losing it, in the request or out of it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const email = `fails-${tag()}@example.com`;
      failing.add(email);
      await signUp(email);
      await endResponse();
      expect(errors).toHaveBeenCalledWith("[auth] confirmation email not sent:", "Resend is down");

      // Outside a request, the send happens straight away and a failure is still only logged.
      errors.mockClear();
      afterResponse.inRequest = false;
      const outside = `fails-out-${tag()}@example.com`;
      failing.add(outside);
      await signUp(outside);
      expect(afterResponse.queue).toHaveLength(0);
      expect(errors).toHaveBeenCalledWith("[auth] confirmation email not sent:", "Resend is down");
      expect(await userBy(outside)).toBeDefined();
    } finally {
      errors.mockRestore();
    }
  });
});
