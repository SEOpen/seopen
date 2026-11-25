import { NextResponse, type NextRequest } from "next/server";
import { track } from "@/lib/analytics/server";
import { hooks } from "@/plan-policy/hooks";
import { env } from "@/lib/env";
import { appOrigin } from "@/lib/hosts";
import { workspaceScope } from "@/lib/workspace/current";
import { newOAuthClient, saveAccount } from "@/modules/google/auth";
import { forgetGoogleProperties } from "@/modules/google/properties";
import { OAUTH_COOKIE, readOAuthCookie, sameState } from "@/modules/google/oauth-cookie";
import { requireSession } from "@/lib/auth/session";

/** Finishes the consent flow: checks state, exchanges the code with PKCE, stores the refresh token. */
export async function GET(request: NextRequest) {
  const user = await requireSession();
  const params = request.nextUrl.searchParams;
  // appOrigin, not request.url: behind a proxy that names the address the server listens on (0.0.0.0:4100 in Docker).
  const back = (query: string) => {
    const res = NextResponse.redirect(new URL(`/gsc?${query}`, appOrigin()));
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/google" });
    return res;
  };

  // The user clicked Cancel, or Google refused (e.g. access_denied for a non-test user).
  const denied = params.get("error");
  if (denied) return back(`google_error=${encodeURIComponent(denied)}`);

  const saved = readOAuthCookie(request.cookies.get(OAUTH_COOKIE)?.value);
  const state = params.get("state");
  const code = params.get("code");
  if (!saved || !state || !code || !sameState(saved.state, state)) return back("google_error=state_mismatch");
  if (saved.userId !== user.id) return back("google_error=account_changed");

  try {
    const client = newOAuthClient();
    const { tokens } = await client.getToken({ code, codeVerifier: saved.codeVerifier });
    if (!tokens.refresh_token) return back("google_error=no_refresh_token");
    if (!tokens.id_token) return back("google_error=no_id_token");

    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env().GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.sub) return back("google_error=no_identity");

    const expiresIn = (tokens as { refresh_token_expires_in?: number }).refresh_token_expires_in ?? null;
    // The connection belongs to the signed-in user's workspace and replaces only its previous one.
    const { workspaceId } = await workspaceScope();
    await saveAccount(workspaceId, {
      email: payload.email ?? "(unknown)",
      googleSub: payload.sub,
      refreshToken: tokens.refresh_token,
      scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
      refreshTokenExpiresInSeconds: expiresIn,
    });
    forgetGoogleProperties(workspaceId);
    // A plan may count the Google account (getseopen.com: one trial per account).
    await hooks.connected(workspaceId, { googleAccount: payload.sub });
    track(user.id, "module_activated", { module: "gsc" }, { workspaceId });
    return back("connected=1");
  } catch (err) {
    console.error("[google] token exchange failed:", err instanceof Error ? err.message : err);
    return back("google_error=token_exchange_failed");
  }
}
