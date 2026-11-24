import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The welcome email against seopen_test, through real Better Auth sign-ins: once on the first, never
 * again, and never for the owner's workspace. The send is stubbed, so nothing reaches Resend.
 */

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
const failNext = vi.hoisted(() => ({ on: false }));
/** Every send's idempotency key, failed ones included, by recipient. */
const keys = vi.hoisted(() => [] as { to: string; key?: string }[]);
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (msg: { to: string; subject: string; text: string }, opts: { idempotencyKey?: string } = {}) => {
    keys.push({ to: msg.to, key: opts.idempotencyKey });
    if (failNext.on) {
      failNext.on = false;
      throw new Error("Resend rejected the message");
    }
    sent.push(msg);
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => {} }), headers: async () => new Headers() }));

const ready = await testDb();

const { db } = await import("@/db");
const { users, workspaceMembers, workspaces } = await import("@/db/schema");
const { auth } = await import("@/lib/auth");
const { sendWelcomeEmail } = await import("./welcome-email");

const PASSWORD = "correct-horse-battery";

/** An account with a password and, unless `plan` is null, a workspace of that plan. */
async function account(plan: string | null = "free", emailVerified = true) {
  const email = `welcome-${randomUUID().slice(0, 8)}@example.com`;
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
  if (plan) {
    const [ws] = await db.insert(workspaces).values({ name: email, plan }).returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  }
  return { id: user.id, email };
}

const signIn = (email: string) => auth.api.signInEmail({ body: { email, password: PASSWORD } });

const welcomesTo = (email: string) => sent.filter((m) => m.to === email);

/** The hook sends without being waited on, so give it a moment before saying nothing arrived. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe.skipIf(!ready)("welcome email", () => {
  beforeEach(() => void (sent.length = 0));

  it("goes out on the first sign-in and not on the second", async () => {
    const { email } = await account();
    await signIn(email);
    await vi.waitFor(() => expect(welcomesTo(email)).toHaveLength(1));
    const [message] = welcomesTo(email);
    expect(message.subject).toBe("Welcome to SEOpen");
    expect(message.text).toContain("/projects/new");

    await signIn(email);
    await settle();
    expect(welcomesTo(email)).toHaveLength(1);
  });

  it("goes out once when two first sign-ins race", async () => {
    const { id, email } = await account();
    await Promise.all(Array.from({ length: 10 }, () => sendWelcomeEmail(id)));
    expect(welcomesTo(email)).toHaveLength(1);
  });

  it("isn't sent for the owner's workspace", async () => {
    const { email } = await account("internal");
    await signIn(email);
    await settle();
    expect(welcomesTo(email)).toHaveLength(0);
  });

  it("waits for a verified email and a workspace", async () => {
    const unverified = await account("free", false);
    await sendWelcomeEmail(unverified.id);
    const noWorkspace = await account(null);
    await sendWelcomeEmail(noWorkspace.id);
    expect(sent).toHaveLength(0);
    const [row] = await db.select({ at: users.welcomeEmailAt }).from(users).where(eq(users.id, noWorkspace.id));
    expect(row.at).toBeNull();
  });

  it("a failed send doesn't break the sign-in, and the next sign-in tries again", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { email, id } = await account();
    failNext.on = true;
    await expect(signIn(email)).resolves.toMatchObject({ user: { email } });
    await vi.waitFor(async () => {
      expect(spy).toHaveBeenCalled();
      const [row] = await db.select({ at: users.welcomeEmailAt }).from(users).where(eq(users.id, id));
      expect(row.at).toBeNull();
    });
    expect(welcomesTo(email)).toHaveLength(0);
    spy.mockRestore();

    await signIn(email);
    await vi.waitFor(() => expect(welcomesTo(email)).toHaveLength(1));
    // The retry reuses the failed send's key, so a send that timed out after Resend took it can't go out twice.
    const tried = keys.filter((k) => k.to === email).map((k) => k.key);
    expect(tried).toEqual([`welcome-email/${id}`, `welcome-email/${id}`]);
  });
});
