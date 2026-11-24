import { isInternal, type BillingWorkspace } from "@/lib/billing/gates";

/**
 * Whether a workspace can connect Umami, or be told it can. The owner's workspace only for now,
 * because the public privacy page lists PostHog as a data source and sub-processor but not Umami.
 * Umami named on the privacy page is what opens this. That page is for the owner and the lawyer to
 * change. docs/umami.md lists what to do then: delete this check and put the copy back.
 *
 * Sync, Admin, the fix report and MCP don't ask, because they only act on a project already mapped.
 */
export const umamiOpen = (ws: BillingWorkspace) => isInternal(ws);

export const UMAMI_CLOSED = "Umami isn't available on this workspace.";
