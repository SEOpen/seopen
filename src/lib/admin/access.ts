import "server-only";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { z } from "zod";
import { db } from "@/db";
import { settings, users, workspaceMembers } from "@/db/schema";
import { requireSession, type CurrentUser } from "@/lib/auth/session";
import { adminInviteMessage, sendEmail } from "@/lib/email";
import { createInvitedAccount, ensureWorkspace, hasSignedIn, setPasswordLink } from "@/lib/invites";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";

/**
 * Who can open /admin. Admin belongs to accounts, not to a workspace: the ids on this list, kept in
 * `settings`. Until anyone is on the list, the owner workspace's members are the admins, which is
 * how it worked before the list existed. Being an admin doesn't move an account's own workspace:
 * an admin with a customer workspace still sees that workspace in the app.
 */
export const ADMINS_SETTING_KEY = "platform.admin_user_ids";

export async function adminUserIds(): Promise<string[]> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, ADMINS_SETTING_KEY));
  return Array.isArray(row?.value) ? row.value.filter((v): v is string => typeof v === "string") : [];
}

export async function isAdmin(userId: string): Promise<boolean> {
  const ids = await adminUserIds();
  if (ids.length) return ids.includes(userId);
  const [member] = await db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, OWNER_WORKSPACE_ID), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return Boolean(member);
}

/** For admin pages: the signed-in admin, or a 404 so /admin doesn't announce itself. Once per request. */
export const requireAdmin = cache(async (): Promise<CurrentUser> => {
  const user = await requireSession();
  if (!(await isAdmin(user.id))) notFound();
  return user;
});

/** For Server Actions: the signed-in admin, or an error. */
export async function assertAdmin(): Promise<CurrentUser> {
  const user = await requireSession();
  if (!(await isAdmin(user.id))) throw new Error("Only an SEOpen admin can do this.");
  return user;
}

async function saveAdmins(ids: string[]) {
  const value = [...new Set(ids)];
  await db.insert(settings).values({ key: ADMINS_SETTING_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export type AdminResult = { ok: boolean; message: string };

/**
 * Adds an admin by email. An address with no account gets one, with a workspace of its own (no
 * plan, no beta seat), and an email with a link to choose a password; one that never signed in gets
 * a fresh link. The first name on the list replaces the owner-workspace fallback, so whoever adds it
 * loses admin unless they're on the list too.
 */
export async function addAdmin(rawEmail: string): Promise<AdminResult> {
  const parsed = z.email().safeParse(rawEmail.trim().toLowerCase());
  if (!parsed.success) return { ok: false, message: "That email address doesn't look right." };
  const email = parsed.data;
  const [existing] = await db.select({ id: users.id, emailVerified: users.emailVerified }).from(users).where(eq(users.email, email)).limit(1);
  // An unconfirmed sign-up may be someone else's squat on the address: adopting it would skip the
  // invite email (it has a password), keep it from lapsing and block the owner's Google sign-in.
  if (existing && !existing.emailVerified) {
    return { ok: false, message: `${email} has an account that hasn't confirmed its email. Once it's confirmed, or it lapses unconfirmed, add it again.` };
  }
  const userId = existing?.id ?? (await createInvitedAccount(email));
  await ensureWorkspace(userId, email);
  const emailed = !(await hasSignedIn(userId));
  if (emailed) await sendEmail({ to: email, ...adminInviteMessage(await setPasswordLink(userId)) });
  await saveAdmins([...(await adminUserIds()), userId]);
  return { ok: true, message: emailed ? `${email} is an admin. We emailed a link to choose a password.` : `${email} is an admin.` };
}

/** Takes an account off the list. The last admin stays, so /admin never falls back by accident. */
export async function removeAdmin(userId: string): Promise<AdminResult> {
  const ids = await adminUserIds();
  if (!ids.includes(userId)) return { ok: false, message: "That account isn't on the admin list." };
  if (ids.length === 1) return { ok: false, message: "That's the last admin. Add another admin first." };
  await saveAdmins(ids.filter((id) => id !== userId));
  return { ok: true, message: "Removed from the admin list." };
}
