// No "server-only": Better Auth imports this, and scripts/create-owner.ts imports Better Auth.
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, lt, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { APIError } from "better-auth/api";
import { db } from "@/db";
import { accounts, signupClaims, users, workspaceMembers } from "@/db/schema";
import { safeCallback } from "@/lib/auth/redirect";
import { normalizeEmail } from "@/lib/email-address";
import { signupOpen } from "@/lib/signup-open";

/**
 * Public sign-up. Everything here does nothing while
 * SEOPEN_SIGNUP_OPEN is off, so the beta's invites and admin accounts work exactly as before.
 *
 * - A self sign-up gets its Free workspace when its email is verified, not when the account is
 *   made: an unverified account owns nothing, so a typo or a squatted address costs nothing. It
 *   does hold the address, though: Better Auth won't link Google to an unverified account (that
 *   would hand a squatter's account to the inbox's owner) and answers a second email sign-up as a
 *   duplicate. So `purgeStaleUnconfirmed` deletes it: at once when Google vouches for the address,
 *   since that is the inbox's owner arriving, and once its confirmation link has expired when
 *   someone signs up with the address by email, since a form proves nothing. Until then an email
 *   sign-up waits, for up to a day. Email sign-ups reach the workspace from the confirmation link;
 *   Google sign-ups arrive verified, so their first session makes it.
 * - One Free account per inbox: an address is compared as `normalizeEmail` sees it, Gmail dots and
 *   `+tags` removed. A verified account at the same inbox refuses the sign-up. The verified inbox
 *   is claimed in `signup_claims`, which outlives the account, so a deleted account's inbox can
 *   sign up again only FREE_RESIGNUP_DAYS after the delete.
 * - Invited and admin-made accounts claim nothing and are never refused here.
 *
 * - Cloudflare Turnstile guards POST /api/auth/sign-up/email while sign-up is open: the form's
 *   widget (src/components/auth/turnstile.tsx) sends a token that src/app/api/auth/[...all]/route.ts
 *   checks with src/lib/turnstile.ts before Better Auth runs. A production build without
 *   TURNSTILE_SECRET_KEY refuses every email sign-up. The Google button needs nothing: Google's
 *   consent screen is its own bot check.
 */

/**
 * How long a deleted account's inbox waits before it can sign up again. A Free workspace gets one
 * audit a calendar week, so a week means deleting and starting again never buys an extra one.
 */
export const FREE_RESIGNUP_DAYS = 7;

/** How long a confirmation link works (Better Auth's `emailVerification.expiresIn`). */
export const CONFIRM_LINK_SECONDS = 60 * 60 * 24;

/**
 * Deletes the account at exactly this address if it's a sign-up nobody confirmed: unverified, a
 * password and no other way in, and no workspace. Nothing that strict can be an invite, an admin,
 * the owner or a customer. Runs when someone signs up with the address (Better Auth's before hook)
 * and when Google vouches for it, so the address's owner gets in instead of being told it's taken.
 * Returns how many it deleted (0 or 1).
 *
 * Such an account can hold an inbox claim: `claimBeforeVerifying` commits the claim before the
 * link marks the address verified, so a step that fails after it leaves an unverified account
 * holding the inbox, which `inboxRefusal` answers as taken for good. The claim goes in the same
 * transaction as the account, so the inbox is free again. Only the deleted account's own claim
 * goes: a verified account is never deleted here, and a claim released by a real delete belongs to
 * an account already gone, so the cooldown after it stays.
 *
 * An email sign-up proves nothing about the inbox, so it only replaces an account older than its
 * confirmation link: a fresh one may be the owner's own, waiting in their inbox. With `vouched`,
 * Google has said this address is its account holder's, so whoever made the unconfirmed account
 * either is that person or never will be, and it goes whatever its age.
 */
export async function purgeStaleUnconfirmed(email: unknown, { vouched = false }: { vouched?: boolean } = {}): Promise<number> {
  if (!signupOpen() || typeof email !== "string" || !email.trim()) return 0;
  const gone = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(users)
      .where(
        and(
          eq(users.email, email.trim().toLowerCase()),
          unconfirmedSignup(),
          vouched ? undefined : sql`${users.createdAt} < now() - make_interval(secs => ${CONFIRM_LINK_SECONDS})`,
        ),
      )
      .returning({ id: users.id });
    // signup_claims.userId is plain text, not a foreign key, so the claim doesn't go by itself.
    if (deleted.length) await tx.delete(signupClaims).where(inArray(signupClaims.userId, deleted.map((u) => u.id)));
    return deleted;
  });
  if (gone.length) console.log(`[signup] deleted an unconfirmed sign-up ${vouched ? "Google vouched for" : "past its link"}: ${gone[0].id}`);
  return gone.length;
}

/**
 * A sign-up nobody confirmed: unverified, a password and no other way in, and no workspace. Nothing
 * that strict can be an invite (counted as verified), an admin, the owner or a customer.
 */
function unconfirmedSignup(): SQL {
  return and(
    eq(users.emailVerified, false),
    sql`exists (select 1 from ${accounts} where ${accounts.userId} = ${users.id} and ${accounts.providerId} = 'credential')`,
    sql`not exists (select 1 from ${accounts} where ${accounts.userId} = ${users.id} and ${accounts.providerId} <> 'credential')`,
    sql`not exists (select 1 from ${workspaceMembers} where ${workspaceMembers.userId} = ${users.id})`,
  )!;
}

/**
 * Days an unconfirmed sign-up is kept: its link lasts a day, so a week is only a margin. /privacy
 * states it. Without this, an address nobody confirmed kept its email and password hash until
 * someone signed up with the same address.
 */
export const UNCONFIRMED_KEEP_DAYS = 7;

/**
 * Deletes every unconfirmed sign-up older than UNCONFIRMED_KEEP_DAYS, with its inbox claim, as
 * purgeStaleUnconfirmed does for one address. Runs daily in `billing.alerts`, whether sign-up is
 * open or not, so closing it again leaves nothing behind. Returns how many it deleted.
 */
export async function purgeUnconfirmedSignups(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - UNCONFIRMED_KEEP_DAYS * 86_400_000);
  const gone = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(users)
      .where(and(unconfirmedSignup(), lt(users.createdAt, cutoff)))
      .returning({ id: users.id });
    if (deleted.length) await tx.delete(signupClaims).where(inArray(signupClaims.userId, deleted.map((u) => u.id)));
    return deleted;
  });
  return gone.length;
}

export type InboxRefusal = { kind: "taken" } | { kind: "cooldown"; until: Date } | { kind: "invalid" };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Query = typeof db | Tx;

/** The SQL twin of `normalizeEmail`, for comparing stored addresses. Tested against it in signup.db.test.ts. */
export function inboxSql(column: AnyPgColumn | SQL): SQL {
  const e = sql`lower(trim(${column}))`;
  const local = sql`split_part(split_part(${e}, '@', 1), '+', 1)`;
  const domain = sql`split_part(${e}, '@', 2)`;
  return sql`(case when ${domain} in ('gmail.com', 'googlemail.com') then replace(${local}, '.', '') || '@gmail.com' else ${local} || '@' || ${domain} end)`;
}

/** The claim's key: a one-way hash of the normalized address, as trial claims do. */
export function inboxHash(normalized: string): string {
  return createHash("sha256").update(`seopen-signup-claim:v1:${normalized}`).digest("hex");
}

/**
 * Why this address can't have a new Free account, or null if it can. `self` is the account asking,
 * which never counts against itself. Reads only; `claimInbox` is the atomic version.
 */
export async function inboxRefusal(email: string, self?: string, q: Query = db): Promise<InboxRefusal | null> {
  const inbox = normalizeEmail(email);
  if (!inbox) return { kind: "invalid" };
  // A verified account at this inbox, whether it signed up, was invited or is an admin.
  const [other] = await q
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.emailVerified, true), sql`${inboxSql(users.email)} = ${inbox}`, self ? ne(users.id, self) : undefined))
    .limit(1);
  if (other) return { kind: "taken" };
  const [claim] = await q.select().from(signupClaims).where(eq(signupClaims.hash, inboxHash(inbox)));
  if (!claim || claim.userId === self) return null;
  const [holder] = await q.select({ id: users.id }).from(users).where(eq(users.id, claim.userId));
  // A holder not yet verified is one whose confirmation link is being opened right now: it proved
  // the inbox first. One whose link failed after the claim is cleared by `purgeStaleUnconfirmed`.
  if (holder) return { kind: "taken" };
  const until = new Date((claim.releasedAt ?? claim.claimedAt).getTime() + FREE_RESIGNUP_DAYS * 86_400_000);
  return until > new Date() ? { kind: "cooldown", until } : null;
}

/**
 * Claims the inbox for `userId`, or says why not. Two aliases verifying at once wait on one lock,
 * so only the first gets it. Runs inside the caller's transaction.
 */
export async function claimInbox(tx: Tx, userId: string, email: string): Promise<InboxRefusal | null> {
  const inbox = normalizeEmail(email);
  if (!inbox) return { kind: "invalid" };
  const hash = inboxHash(inbox);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`seopen-signup-claim:${hash}`}, 0))`);
  const refusal = await inboxRefusal(email, userId, tx);
  if (refusal) return refusal;
  await tx
    .insert(signupClaims)
    .values({ hash, userId })
    .onConflictDoUpdate({ target: signupClaims.hash, set: { userId, claimedAt: sql`now()`, releasedAt: null } });
  return null;
}

export type FreeWorkspaceResult = "closed" | "unverified" | "member" | "admin" | "made" | InboxRefusal;

/**
 * A Free workspace for a verified self sign-up, made once however often this runs: after the
 * confirmation link, and on every session while the account has none, which covers Google sign-ups
 * and retries a failed attempt. Accounts with a workspace (invites, the owner) are left alone, and
 * so are admins, whose account outlives its workspace on purpose (src/lib/workspace/delete.ts).
 */
export async function openFreeWorkspace(userId: string): Promise<FreeWorkspaceResult> {
  if (!signupOpen()) return "closed";
  const [user] = await db
    .select({
      email: users.email,
      emailVerified: users.emailVerified,
      member: sql<boolean>`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.userId} = ${users.id})`,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.emailVerified) return "unverified";
  if (user.member) return "member";
  // Imported here: both import Better Auth, which imports this file.
  const [{ isAdmin }, { ensureWorkspace }] = await Promise.all([import("@/lib/admin/access"), import("@/lib/invites")]);
  if (await isAdmin(userId)) return "admin";
  return db.transaction(async (tx) => {
    const refusal = await claimInbox(tx, userId, user.email);
    if (refusal) {
      console.warn(`[signup] ${userId}: no workspace, the inbox is ${refusal.kind}`);
      return refusal;
    }
    return (await ensureWorkspace(userId, user.email, tx, "signup")) ? "made" : "member";
  });
}

/** "Nov 14, 2026": the day a deleted account's inbox can sign up again. */
export const reopenDate = (until: Date) => until.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** What the sign-up and verification pages say for each refusal code. Keys are the `error` query values. */
export const SIGNUP_ERRORS: Record<string, string> = {
  inbox_taken: "This inbox already has a SEOpen account, counting Gmail dots and +tags as the same address. Sign in with that account instead.",
  inbox_cooldown: "This inbox had a SEOpen account that was deleted recently. It can make a new one a week after the delete.",
};

/** The code an `InboxRefusal` travels as in a URL. */
export const refusalCode = (r: InboxRefusal) => (r.kind === "cooldown" ? "inbox_cooldown" : "inbox_taken");

/**
 * Better Auth's user create hook, for a self sign-up only. `path` is the Better Auth endpoint making
 * the account, and every one counts: email sign-up, the Google callback, and `/sign-in/social` with
 * a Google ID token, which makes an account too once sign-up is open. Invites and admin accounts
 * are made outside any endpoint, so they have no path and are never refused. Throws a 403 for an
 * inbox that can't have another account. Better Auth answers an email sign-up's 403 exactly as it
 * answers an address that already exists, so the form gives nothing away; `notify` tells the inbox
 * itself, after the response, so the refusal takes no longer than a sign-up that sends nothing
 * (sendAfterResponse in src/lib/auth/index.ts). The Google callback sends the code back to the page
 * as `?error=`.
 */
export async function refuseTakenInbox(email: string, path: string | undefined, notify: (refusal: InboxRefusal) => Promise<void>): Promise<void> {
  if (!signupOpen() || !path) return;
  const viaEmail = path === "/sign-up/email";
  const refusal = await inboxRefusal(email);
  if (!refusal) return;
  if (viaEmail && refusal.kind !== "invalid") await notify(refusal);
  throw new APIError("FORBIDDEN", { code: refusal.kind === "invalid" ? "invalid_email" : refusalCode(refusal), message: refusal.kind === "invalid" ? "That email address doesn't look right." : SIGNUP_ERRORS[refusalCode(refusal)] });
}

/**
 * The confirmation link sends everyone to /set-password, whatever callback the sign-up asked for,
 * keeping that callback as `next` when it's one of our pages. Better Auth adds `?error=` to it when
 * a link fails, and /set-password passes that on to /verify-email.
 */
export function confirmLink(url: string): string {
  const link = new URL(url);
  const next = safeCallback(link.searchParams.get("callbackURL"));
  link.searchParams.set("callbackURL", next === "/" ? "/set-password" : `/set-password?next=${encodeURIComponent(next)}`);
  return link.toString();
}

/**
 * Better Auth's hook just before a confirmation link marks the address verified, after the inbox
 * claim. The link reaches the inbox, but the password was typed by whoever filled in the form, and
 * that may not be the inbox's owner: someone could sign up with another person's address, wait for
 * them to confirm it, then sign in. So the password goes and every session of the account ends,
 * before the address counts as verified, so there's no moment when the old password works. The
 * person who opened the link is signed in straight after and chooses a password on /set-password,
 * or signs in with Google from then on.
 *
 * Runs whether sign-up is open or not: only a self sign-up can reach it (invited and admin-made
 * accounts are verified when they're made), and one made while sign-up was open stays just as safe
 * if it's confirmed after sign-up closes. The credential row stays, without a password, which is
 * the state Better Auth's setPassword expects and keeps `purgeStaleUnconfirmed` able to find a link
 * that fails after this.
 */
export async function clearSignupPassword(userId: string): Promise<void> {
  // Imported here: Better Auth imports this file.
  const { auth } = await import("@/lib/auth");
  const ctx = await auth.$context;
  const credential = await ctx.internalAdapter.findCredentialAccount(userId);
  if (credential?.password) await ctx.internalAdapter.updateAccount(credential.id, { password: null });
  await ctx.internalAdapter.deleteUserSessions(userId);
}

/** Whether the account has a password to sign in with. */
export async function hasPassword(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential"), isNotNull(accounts.password)))
    .limit(1);
  return Boolean(row);
}

/**
 * Better Auth's hook just before a confirmation link marks the address verified: claims the inbox
 * first, so a second alias that gets here later stays unverified and is sent to /verify-email with
 * the reason instead of into an account with no workspace.
 */
export async function claimBeforeVerifying(user: { id: string; email: string }, baseUrl: string): Promise<void> {
  if (!signupOpen()) return;
  const [member] = await db.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, user.id)).limit(1);
  if (member) return;
  const refusal = await db.transaction((tx) => claimInbox(tx, user.id, user.email));
  if (!refusal) return;
  throw new APIError("FOUND", undefined, new Headers({ location: `${baseUrl}/verify-email?error=${refusalCode(refusal)}` }));
}
