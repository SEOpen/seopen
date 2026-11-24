import type { BillingProvider } from "./provider";

/**
 * No payment provider: a self-hosted copy. Nothing can be bought, so no workspace has a trial or a
 * subscription to end, and deleting one has nothing to cancel.
 */
export const provider: BillingProvider = {
  configured: () => false,
  endTrialNow: async () => ({ ok: false, code: "not_configured" }),
  cancelSubscriptionsForWorkspace: async () => {},
};
