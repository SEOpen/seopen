/**
 * What core billing asks of a payment provider. Plans, gates,
 * caps and spend are core; taking money is the provider's. Code imports the provider as
 * `@/billing-provider`, which resolves to `stripe-provider.ts` where that file exists (getseopen.com)
 * and to `no-provider.ts` otherwise (`billingProviderFile`, which next.config.ts and vitest.config.ts
 * read). tsconfig.json lists both, Stripe first, for tsc and tsx (the worker): `@/billing-*` to
 * `stripe-*` then `no-*`, since SWC refuses a list of files for an exact path and tsc doesn't fill in a
 * `*` that matched nothing. Checkout, the portal and the webhook are the provider's own routes.
 */

export type EndTrialResult = { ok: true } | { ok: false; code: "not_configured" | "card_error" | "error"; message?: string };

export interface BillingProvider {
  /** Whether checkout can run here. False shows /billing's "Billing isn't switched on" note. */
  configured(): boolean;
  /** Ends a trial now and charges its first invoice; refused if the charge fails. */
  endTrialNow(subscriptionId: string): Promise<EndTrialResult>;
  /** Stops every subscription that could still bill a workspace about to be deleted. Throws when that can't be confirmed. */
  cancelSubscriptionsForWorkspace(workspaceId: number): Promise<void>;
  /**
   * When that cancel throws: the server log's tag for the provider, and what the person deleting the
   * workspace reads. Without it core logs `billing` and says so without naming a provider.
   */
  cancelFailure?: { logTag: string; message: string };
}
