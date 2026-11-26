import "server-only";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, workspaceMembers, workspaces } from "@/db/schema";
import { auth } from "@/lib/auth";
import { resetPageLink, revokeResetLinks } from "@/lib/auth/reset-links";
import { hooks } from "@/plan-policy/hooks";

/** Accounts an operator makes for someone: Admin's new admins and, on getseopen.com, waitlist invites. */

/** How long an invite's set-password link works. A normal reset link lasts an hour. */
const INVITE_LINK_DAYS = 7;

/** An account for `email` with no password yet, counted as verified because only that inbox gets the link. */
export async function createInvitedAccount(email: string): Promise<string> {
  const ctx = await auth.$context;
  return (await ctx.internalAdapter.createUser({ email, name: "", emailVerified: true }, { method: "admin" })).id;
}

/** Whether the account has ever signed in: it has a password or a linked Google account. */
export async function hasSignedIn(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId)).limit(1);
  return Boolean(row);
}

/** A link to choose the account's password, good for INVITE_LINK_DAYS and once only. Any earlier one stops working. */
export async function setPasswordLink(userId: string): Promise<string> {
  const ctx = await auth.$context;
  // A resent invite replaces the last one: only the newest link works.
  await revokeResetLinks(userId);
  const token = randomBytes(24).toString("base64url");
  await ctx.internalAdapter.createVerificationValue({
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + INVITE_LINK_DAYS * 86_400_000),
  });
  // Straight to the reset page, the token in the query (resetPageLink says why).
  return resetPageLink(new URL(ctx.baseURL).origin, token, true);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A workspace of the account's own, unless it already has one. Used by invites, admins and self
 * sign-up (a hosted service's, src/lib/public-signup/types.ts), which passes `by: "signup"`. Its plan is the plan policy's
 * (`newWorkspacePlan`, src/lib/billing/policy.ts).
 * Safe to call any number of times at once: a lock on the account makes a second call wait, then
 * find the first one's workspace. Pass `tx` to run inside a caller's transaction. Returns whether
 * it made one.
 */
export async function ensureWorkspace(userId: string, email: string, tx?: Tx, by: "operator" | "signup" = "operator"): Promise<boolean> {
  const run = async (t: Tx) => {
    await t.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seopen-workspace:${userId}`}, 0))`);
    const [member] = await t.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).limit(1);
    if (member) return false;
    const [ws] = await t.insert(workspaces).values({ name: email.split("@")[0], plan: hooks.newWorkspacePlan(by) }).returning({ id: workspaces.id });
    await t.insert(workspaceMembers).values({ workspaceId: ws.id, userId, role: "owner" });
    return true;
  };
  return tx ? run(tx) : db.transaction(run);
}
