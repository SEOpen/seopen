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
