import "server-only";
import { eq, like } from "drizzle-orm";
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
 * Only for a person in the app: no MCP tool can call this, and this file is `server-only` so no
 * job can reach it either.
 */
export async function deleteWorkspaceOp(scope: WorkspaceScope, actor: Actor, typed: string, opts: OpOptions = {}): Promise<DeletedWorkspace> {
  const { workspaceId } = scope;
  const [workspace] = await db.select({ name: workspaces.name, status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new OpError("No such workspace.");
  if (workspaceId === OWNER_WORKSPACE_ID) throw new OpError("The owner's workspace can't be deleted.");
  const members = await db.select({ userId: workspaceMembers.userId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
  if (members.find((m) => m.userId === actor.userId)?.role !== "owner") throw new OpError("Only the workspace's owner can delete it.");
  if (typed.trim().toLowerCase() !== "delete") throw new OpError("Type delete to confirm.");
  const stillRunning = new OpError("A check is still running. Delete the workspace once that finishes.");
  if (await anyCheckRunning(scope)) throw stillRunning;
  if (opts.dryRun) return { dryRun: true, accountRemoved: false, message: `Would delete ${workspace.name}.` };

  const setStatus = (status: string) => db.update(workspaces).set({ status }).where(eq(workspaces.id, workspaceId));
  await setStatus("suspended");
  try {
    // A check could have started just before the suspend took effect.
    if (await anyCheckRunning(scope)) throw stillRunning;
    try {
      await provider.cancelSubscriptionsForWorkspace(workspaceId);
    } catch (err) {
      const failure = provider.cancelFailure ?? CANCEL_FAILURE;
      console.error(`[workspace.delete] ${workspaceId}: ${failure.logTag}:`, err);
      throw new OpError(failure.message);
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
        if (admins.get(userId) || (await tx.$count(workspaceMembers, eq(workspaceMembers.userId, userId))) > 0) continue;
        const [gone] = await tx.delete(users).where(eq(users.id, userId)).returning({ email: users.email });
        if (gone) await tx.delete(waitlist).where(eq(waitlist.email, gone.email.toLowerCase()));
        // A self sign-up's inbox claim stays, as a hash, and starts its wait before it can sign up again, where the copy has public sign-up.
        await tx.update(signupClaims).set({ releasedAt: new Date() }).where(eq(signupClaims.userId, userId));
        accountRemoved ||= userId === actor.userId;
      }
    });
    track(actor.userId, "workspace_deleted", {}, { workspaceId });
    return { dryRun: false, accountRemoved, message: `Deleted ${workspace.name}.` };
  } catch (err) {
    await setStatus(workspace.status);
    if (err instanceof OpError) throw err;
    console.error(`[workspace.delete] ${workspaceId}:`, err);
    throw new OpError(`${rules.hasPlans ? "Any paid subscription is cancelled and Google" : "Google"} and PostHog are disconnected, but deleting the data failed, so it's all still here. Try again in a moment.`);
  }
}

/** Disconnects what the workspace connected. Returns the name of one that refused, or null. */
async function disconnectEverything(workspaceId: number): Promise<string | null> {
  const [google, posthog] = await Promise.all([disconnectAccount(workspaceId), disconnectPosthogAccount(workspaceId)]);
  if (!google.ok) console.error(`[workspace.delete] ${workspaceId}: Google:`, google.error);
  if (!posthog.ok) console.error(`[workspace.delete] ${workspaceId}: PostHog:`, posthog.error);
  return !google.ok ? "Google" : !posthog.ok ? "PostHog" : null;
}
