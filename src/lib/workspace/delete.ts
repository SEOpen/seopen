import "server-only";
import { and, asc, eq, like, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiCache, oauthAccessTokens, oauthConsents, oauthRefreshTokens, signupClaims, users, waitlist, workspaceMembers, workspaces } from "@/db/schema";
import { isAdmin } from "@/lib/admin/access";
import { track } from "@/lib/analytics/server";
import { provider } from "@/billing-provider";
import { OpError, type Actor, type OpOptions } from "@/lib/ops";
import { OWNER_WORKSPACE_ID, type WorkspaceScope } from "@/lib/workspace";
import { disconnectAccount } from "@/modules/google/auth";
import { disconnectPosthogAccount } from "@/modules/posthog/account";
import { rules } from "@/plan-policy/rules";
import { anyCheckRunning } from "./running";

export interface DeletedWorkspace {
  dryRun: boolean;
  /** The signed-in account went too, because it had no other workspace. */
  accountRemoved: boolean;
  message: string;
}

/** A failed cancel, for a billing provider that words none of its own (`cancelFailure`). */
const CANCEL_FAILURE = {
  logTag: "billing",
  message: "Your subscription couldn't be confirmed as cancelled, so nothing was deleted. Try again in a moment.",
};

/** The same failure said to an admin, whose subscription it isn't. */
const ADMIN_CANCEL_FAILURE = "The workspace's subscription couldn't be confirmed as cancelled, so it wasn't deleted. Try again in a moment.";

const STILL_RUNNING = "A check is still running. Delete the workspace once that finishes.";
const OWNER_WORKSPACE = "The owner's workspace can't be deleted.";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Target = { id: number; name: string; status: string };
type Member = { userId: string; role: string };

const workspaceById = async (id: number): Promise<Target | undefined> =>
  (await db.select({ id: workspaces.id, name: workspaces.name, status: workspaces.status }).from(workspaces).where(eq(workspaces.id, id)))[0];

const membersOf = (workspaceId: number): Promise<Member[]> =>
  db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));

function confirmTyped(typed: string) {
  if (typed.trim().toLowerCase() !== "delete") throw new OpError("Type delete to confirm.");
}

/** Every admin op starts here, so no caller can reach one without the check, whatever its action did. */
async function assertAdminActor(actor: Actor) {
  if (actor.source !== "app" || !(await isAdmin(actor.userId))) throw new OpError("Only an admin can do this.");
}

/**
 * Permanently deletes a workspace and everything stored for it, as the privacy page promises. In
 * order: suspend it so no new job starts or spends, cancel any paid subscription through the billing
 * provider (`@/billing-provider`), disconnect Google and PostHog,
 * then delete in one transaction, whose cascade takes the Plausible key and the Umami key or token (neither has an API SEOpen can revoke them with). Any failure before the delete puts its status back and refuses,
 * and running it again picks up where it stopped, since each step is safe to repeat.
 *
 * A running check refuses, as it does for a project, because it would go on writing. A row stuck past
 * any real check's length doesn't count (`anyCheckRunning`), so it can't hold the promise up. Trial claims
 * and sign-up inbox claims outlive the workspace on purpose (they have no foreign key); a Free site claim goes
 * with it (its foreign key cascades), so another Free workspace can add the site. An account left with no workspace is
 * deleted too, since it couldn't open the app and the privacy page says everything goes; an admin's
 * account stays, because /admin belongs to the account.
 *
 * Only for the workspace's owner, in the app. An admin deleting someone else's goes through
 * `deleteWorkspaceAsAdminOp`. No MCP tool can call either, and this file is `server-only` so no
 * job can reach it.
 */
export async function deleteWorkspaceOp(scope: WorkspaceScope, actor: Actor, typed: string, opts: OpOptions = {}): Promise<DeletedWorkspace> {
  const { workspaceId } = scope;
  const workspace = await workspaceById(workspaceId);
  if (!workspace) throw new OpError("No such workspace.");
  if (workspaceId === OWNER_WORKSPACE_ID) throw new OpError(OWNER_WORKSPACE);
  const members = await membersOf(workspaceId);
  if (members.find((m) => m.userId === actor.userId)?.role !== "owner") throw new OpError("Only the workspace's owner can delete it.");
  confirmTyped(typed);
  if (await anyCheckRunning(scope)) throw new OpError(STILL_RUNNING);
  if (opts.dryRun) return { dryRun: true, accountRemoved: false, message: `Would delete ${workspace.name}.` };
  return eraseWorkspace(workspace, members, actor, "owner");
}

/** Admin → Workspaces: deletes any workspace but the owner's, the same way its own owner's delete does. */
export async function deleteWorkspaceAsAdminOp(workspaceId: number, actor: Actor, typed: string): Promise<DeletedWorkspace> {
  await assertAdminActor(actor);
  const workspace = await workspaceById(workspaceId);
  if (!workspace) throw new OpError("No such workspace.");
  if (workspaceId === OWNER_WORKSPACE_ID) throw new OpError(OWNER_WORKSPACE);
  confirmTyped(typed);
  if (await anyCheckRunning({ workspaceId })) throw new OpError(STILL_RUNNING);
  return eraseWorkspace(workspace, await membersOf(workspaceId), actor, "admin");
}

/** Why an account can't be deleted from Admin, or null, with the workspaces that would go with it. */
export async function userDeletion(userId: string, actorId: string): Promise<{ refusal: string | null; workspaces: Target[] }> {
  const refuse = (refusal: string) => ({ refusal, workspaces: [] });
  if (userId === actorId) return refuse("You can't delete your own account here.");
  if (await isAdmin(userId)) return refuse("This is an admin. Remove it from the admins first.");
  const owned = await db
    .select({ id: workspaces.id, name: workspaces.name, status: workspaces.status, members: sql<number>`(select count(*)::int from workspace_members m where m.workspace_id = "workspaces"."id")` })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner")))
    .orderBy(asc(workspaces.id));
  if (owned.some((w) => w.id === OWNER_WORKSPACE_ID)) return refuse(OWNER_WORKSPACE);
  const shared = owned.find((w) => w.members > 1);
  if (shared) return refuse(`Other people belong to ${shared.name}. Delete that workspace first.`);
  return { refusal: null, workspaces: owned.map(({ id, name, status }) => ({ id, name, status })) };
}

/**
 * Admin → Users: deletes an account and the workspaces only it belongs to. Each goes through the same
 * steps as any other delete, so its subscription is cancelled and nothing is left billing. Never the
 * signed-in admin or another one, and never a workspace other people are in. One that fails stops
 * there, and running it again picks up where it stopped.
 */
export async function deleteUserAsAdminOp(userId: string, actor: Actor, typed: string): Promise<{ message: string }> {
  await assertAdminActor(actor);
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user) throw new OpError("No such account.");
  const { refusal, workspaces: owned } = await userDeletion(userId, actor.userId);
  if (refusal) throw new OpError(refusal);
  confirmTyped(typed);
  for (const { id, name } of owned) if (await anyCheckRunning({ workspaceId: id })) throw new OpError(`A check is still running in ${name}. Delete the account once that finishes.`);
  for (const workspace of owned) await eraseWorkspace(workspace, await membersOf(workspace.id), actor, "admin");
  await db.transaction(async (tx) => {
    // A place in someone else's workspace doesn't keep the account. One it owns by now does, so nothing is orphaned.
    await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, "owner")));
    await removeAccountWithNoWorkspace(tx, userId);
  });
  if ((await db.$count(users, eq(users.id, userId))) > 0) throw new OpError("The account has a new workspace since this started. Try again.");
  console.warn(`[admin] account ${userId} deleted by ${actor.userId}`);
  return { message: `Deleted ${user.email}.` };
}

/** The accounts a workspace's delete takes with it: its members with no other workspace, admins apart. */
export async function accountsGoingWith(workspaceId: number): Promise<string[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, others: sql<number>`(select count(*)::int from workspace_members m where m.user_id = "users"."id" and m.workspace_id <> ${workspaceId})` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(users.email));
  const going: string[] = [];
  for (const r of rows) if (r.others === 0 && !(await isAdmin(r.id))) going.push(r.email);
  return going;
}

/** The steps `deleteWorkspaceOp` describes, for a workspace its caller has already checked may go. */
async function eraseWorkspace(workspace: Target, members: Member[], actor: Actor, by: "owner" | "admin"): Promise<DeletedWorkspace> {
  const workspaceId = workspace.id;
  const setStatus = (status: string) => db.update(workspaces).set({ status }).where(eq(workspaces.id, workspaceId));
  await setStatus("suspended");
  try {
    // A check could have started just before the suspend took effect.
    if (await anyCheckRunning({ workspaceId })) throw new OpError(STILL_RUNNING);
    try {
      await provider.cancelSubscriptionsForWorkspace(workspaceId);
    } catch (err) {
      const failure = provider.cancelFailure ?? CANCEL_FAILURE;
      console.error(`[workspace.delete] ${workspaceId}: ${failure.logTag}:`, err);
      throw new OpError(by === "admin" ? ADMIN_CANCEL_FAILURE : failure.message);
    }
    const left = await disconnectEverything(workspaceId);
    if (left) throw new OpError(`${rules.hasPlans ? "Any paid subscription is cancelled, but " : ""}${left} couldn't be disconnected, so nothing was deleted. Try again in a moment.`);

    const admins = new Map(await Promise.all(members.map(async (m) => [m.userId, await isAdmin(m.userId)] as const)));
    let accountRemoved = false;
    await db.transaction(async (tx) => {
      // Lookups cached for this workspace alone. Shared entries are public market data and stay.
      await tx.delete(apiCache).where(like(apiCache.key, `w${workspaceId}:%`));
      await tx.delete(workspaces).where(eq(workspaces.id, workspaceId));
      // Apps connected over OAuth: their consents and tokens name the workspace in `reference_id`,
      // with no foreign key, so an account that stays (an admin, or one in another workspace) would keep them.
      const ref = String(workspaceId);
      await tx.delete(oauthConsents).where(eq(oauthConsents.referenceId, ref));
      await tx.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.referenceId, ref));
      await tx.delete(oauthAccessTokens).where(eq(oauthAccessTokens.referenceId, ref));
      for (const { userId } of members) {
        if (admins.get(userId) || !(await removeAccountWithNoWorkspace(tx, userId))) continue;
        accountRemoved ||= userId === actor.userId;
      }
    });
    if (by === "admin") console.warn(`[admin] workspace ${workspaceId} deleted by ${actor.userId}`);
    track(actor.userId, "workspace_deleted", { by }, { workspaceId });
    return { dryRun: false, accountRemoved, message: `Deleted ${workspace.name}.` };
  } catch (err) {
    await setStatus(workspace.status);
    if (err instanceof OpError) throw err;
    console.error(`[workspace.delete] ${workspaceId}:`, err);
    throw new OpError(`${rules.hasPlans ? "Any paid subscription is cancelled and Google" : "Google"} and PostHog are disconnected, but deleting the data failed, so it's all still here. Try again in a moment.`);
  }
}

/** Deletes an account that belongs to no workspace, and its waitlist entry. False, and nothing done, when it still has one. */
async function removeAccountWithNoWorkspace(tx: Tx, userId: string): Promise<boolean> {
  if ((await tx.$count(workspaceMembers, eq(workspaceMembers.userId, userId))) > 0) return false;
  const [gone] = await tx.delete(users).where(eq(users.id, userId)).returning({ email: users.email });
  if (gone) await tx.delete(waitlist).where(eq(waitlist.email, gone.email.toLowerCase()));
  // A self sign-up's inbox claim stays, as a hash, and starts its wait before it can sign up again, where the copy has public sign-up.
  await tx.update(signupClaims).set({ releasedAt: new Date() }).where(eq(signupClaims.userId, userId));
  return true;
}

/** Disconnects what the workspace connected. Returns the name of one that refused, or null. */
async function disconnectEverything(workspaceId: number): Promise<string | null> {
  const [google, posthog] = await Promise.all([disconnectAccount(workspaceId), disconnectPosthogAccount(workspaceId)]);
  if (!google.ok) console.error(`[workspace.delete] ${workspaceId}: Google:`, google.error);
  if (!posthog.ok) console.error(`[workspace.delete] ${workspaceId}: PostHog:`, posthog.error);
  return !google.ok ? "Google" : !posthog.ok ? "PostHog" : null;
}
