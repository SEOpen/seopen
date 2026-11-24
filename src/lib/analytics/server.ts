import { after } from "next/server";
import { PostHog } from "posthog-node";
import { posthogHost, posthogKey } from "./config";

/**
 * The funnel events SEOpen sends from the server (docs/conventions.md, "Analytics"). Properties
 * never carry an email, a domain or a site URL.
 */
export type AnalyticsEvent =
  | "user_signed_up"
  | "project_created"
  | "project_deleted"
  | "workspace_deleted"
  | "module_activated"
  | "fixes_applied"
  | "fixes_dismissed"
  | "checkout_started"
  | "checkout_completed"
  | "api_key_created"
  | "setup_applied"
  | "waitlist_joined";

type Properties = Record<string, string | number | boolean | null | undefined>;

let client: PostHog | null | undefined;

/** Whether events are sent at all, so callers can skip the queries an event needs. */
export const analyticsEnabled = (): boolean => posthogKey() !== null;

function posthog(): PostHog | null {
  if (client === undefined) {
    const key = posthogKey();
    // Server functions are short-lived: send each event straight away rather than batching.
    client = key ? new PostHog(key, { host: posthogHost(), flushAt: 1, flushInterval: 0 }) : null;
  }
  return client;
}

/**
 * Sends one event after the response, so analytics never slows or breaks the request. Outside a
 * request (scripts, tests) it sends straight away. A no-op without NEXT_PUBLIC_POSTHOG_KEY.
 *
 * `distinctId` is the Better Auth user id, the same id the browser identifies with. Events with a
 * workspace carry `workspace_id` as a plain property (breakdowns work on PostHog's free plan) and
 * as the `workspace` group (used only if group analytics is ever switched on). `anonymous` events
 * make no person profile; the waitlist uses it, as nobody is signed in there.
 */
export function track(
  distinctId: string,
  event: AnalyticsEvent,
  properties: Properties = {},
  opts: { workspaceId?: number; anonymous?: boolean } = {},
): void {
  const ph = posthog();
  if (!ph) return;
  const send = async () => {
    try {
      ph.capture({
        distinctId,
        event,
        properties: {
          ...properties,
          ...(opts.workspaceId ? { workspace_id: opts.workspaceId } : {}),
          ...(opts.anonymous ? { $process_person_profile: false } : {}),
        },
        groups: opts.workspaceId ? { workspace: String(opts.workspaceId) } : undefined,
      });
      await ph.flush();
    } catch (err) {
      console.error(`[analytics] ${event} not sent:`, err instanceof Error ? err.message : err);
    }
  };
  try {
    after(send);
  } catch {
    void send();
  }
}
