import { isInternal, type BillingWorkspace } from "@/lib/billing/gates";

/**
 * Whether a workspace can connect Plausible, or be told it can. The owner's workspace only for now,
 * because the public privacy page lists PostHog as a data source and sub-processor but not Plausible.
 * Plausible named on the privacy page is what opens this. That page is for the owner and the lawyer to
 * change. docs/plausible.md lists what to do then: delete this check and put the copy back.
 *
 * Sync, Admin, the fix report and MCP don't ask, because they only act on a project already mapped.
 */
export const plausibleOpen = (ws: BillingWorkspace) => isInternal(ws);

export const PLAUSIBLE_CLOSED = "Plausible isn't available on this workspace.";
