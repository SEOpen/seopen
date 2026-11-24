import { rules } from "@/plan-policy/rules";

/**
 * What the Delete this workspace card says will happen. An admin's account outlives the workspace
 * (`deleteWorkspaceOp`), because Admin belongs to the account, so for an admin it says so. A copy
 * without plans has no subscription to cancel, so it doesn't mention one. Pure.
 */
export function deleteWorkspaceDescription(admin: boolean): string {
  const account = admin
    ? "Your account stays, because it's an admin account. If this is your only workspace, you'll land in Admin, since the rest of the app needs a workspace."
    : "If this is your only workspace, your account goes too.";
  const deletes = rules.hasPlans ? "This deletes every project and report, disconnects Google and PostHog, and cancels any paid subscription straight away." : "This deletes every project and report and disconnects Google and PostHog straight away.";
  return `${deletes} ${account} It can't be undone, so export first. Backups that still hold your data expire within 35 days.`;
}

const CANT_UNDO = "It can't be undone. Backups that still hold the data expire within 35 days.";
const list = (items: string[]) => new Intl.ListFormat("en-US").format(items);

/** The Delete card on a workspace's Admin page, with the accounts that go too (`accountsGoingWith`). */
export function adminDeleteWorkspaceDescription(accounts: string[]): string {
  const deletes = `Deletes every project and report${rules.hasPlans ? ", disconnects Google and PostHog, and cancels any paid subscription straight away. A cancelled subscription isn't refunded" : " and disconnects Google and PostHog"}.`;
  const going = accounts.length ? `${accounts.length === 1 ? "This account has" : "These accounts have"} no other workspace and ${accounts.length === 1 ? "goes" : "go"} too: ${list(accounts)}.` : "No account goes with it.";
  return `${deletes} ${going} ${CANT_UNDO}`;
}

/** The Delete card on an account's Admin page, with the workspaces that go too (`userDeletion`). */
export function adminDeleteUserDescription(workspaces: string[]): string {
  if (!workspaces.length) return `Deletes the account. It owns no workspace. ${CANT_UNDO}`;
  const what = `${workspaces.length === 1 ? "its workspace" : "its workspaces"}, ${list(workspaces)}, with every project and report`;
  return `Deletes the account and ${what}${rules.hasPlans ? ", and cancels any paid subscription straight away. A cancelled subscription isn't refunded" : ""}. ${CANT_UNDO}`;
}
