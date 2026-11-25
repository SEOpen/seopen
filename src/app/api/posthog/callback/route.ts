import { NextResponse, type NextRequest } from "next/server";
import { track } from "@/lib/analytics/server";
import { requireSession } from "@/lib/auth/session";
import { appOrigin } from "@/lib/hosts";
import { workspaceScope } from "@/lib/workspace/current";
import { savePosthogAccount } from "@/modules/posthog/account";
import { exchangeCode, PosthogOAuthError } from "@/modules/posthog/oauth";
import { POSTHOG_COOKIE, readPosthogCookie } from "@/modules/posthog/oauth-cookie";
import { forgetPosthogProjects } from "@/modules/posthog/projects";
import { sameState } from "@/modules/google/oauth-cookie";

/** Finishes PostHog consent: checks state, exchanges the code with PKCE, stores the tokens. */
export async function GET(request: NextRequest) {
  const user = await requireSession();
  const params = request.nextUrl.searchParams;
  const back = (query: string) => {
    const res = NextResponse.redirect(new URL(`/ga4?${query}`, appOrigin()));
    res.cookies.delete({ name: POSTHOG_COOKIE, path: "/api/posthog" });
    return res;
  };

  // The user clicked Cancel, or PostHog refused.
  const denied = params.get("error");
  if (denied) return back(`posthog_error=${encodeURIComponent(denied)}`);

  const saved = readPosthogCookie(request.cookies.get(POSTHOG_COOKIE)?.value);
  const state = params.get("state");
  const code = params.get("code");
  if (!saved || !state || !code || !sameState(saved.state, state)) return back("posthog_error=state_mismatch");
  if (saved.userId !== user.id) return back("posthog_error=account_changed");

  try {
    const tokens = await exchangeCode(saved.region, code, saved.codeVerifier);
    const { workspaceId } = await workspaceScope();
    await savePosthogAccount(workspaceId, saved.region, tokens);
    forgetPosthogProjects(workspaceId);
    track(user.id, "module_activated", { module: "posthog" }, { workspaceId });
    return back("posthog_connected=1");
  } catch (err) {
    console.error("[posthog] token exchange failed:", err instanceof Error ? err.message : err);
    return back(`posthog_error=${err instanceof PosthogOAuthError ? encodeURIComponent(err.code) : "token_exchange_failed"}`);
  }
}
