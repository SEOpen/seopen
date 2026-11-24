import { posthogKey, posthogUiHost } from "@/lib/analytics/config";
import { getCurrentUser } from "@/lib/auth/session";
import { currentWorkspace } from "@/lib/workspace/current";
import { PostHogClient } from "./posthog-client";

/** Mounted by the `(app)` layout inside a Suspense boundary. Renders nothing without a PostHog key. */
export async function PostHogAnalytics() {
  const apiKey = posthogKey();
  if (!apiKey) return null;
  const user = await getCurrentUser();
  if (!user) return null;
  // An account without a workspace gets the page's own error; analytics just stays out of the way.
  const ws = await currentWorkspace().catch(() => null);
  if (!ws) return null;
  return <PostHogClient apiKey={apiKey} uiHost={posthogUiHost()} userId={user.id} workspaceId={ws.id} plan={ws.plan} />;
}
