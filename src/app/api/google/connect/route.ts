import { randomBytes } from "node:crypto";
import { CodeChallengeMethod } from "google-auth-library";
import { NextResponse, type NextRequest } from "next/server";
import { encrypt } from "@/lib/crypto";
import { newOAuthClient, oauthConfigured } from "@/modules/google/auth";
import { OAUTH_COOKIE } from "@/modules/google/oauth-cookie";
import { SCOPES } from "@/modules/google/types";
import { requireSession } from "@/lib/auth/session";

/**
 * Starts the Google consent flow: state + PKCE verifier go into a short-lived httpOnly cookie.
 * Secure, as the PostHog flow's is. Browsers treat localhost as secure, so it still works on local http.
 */
export async function GET(request: NextRequest) {
  await requireSession();
  if (!oauthConfigured()) return NextResponse.redirect(new URL("/gsc?google_error=not_configured", request.url));

  const client = newOAuthClient();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(32).toString("base64url");
  const url = client.generateAuthUrl({
    access_type: "offline",
    // Always return a refresh token; it otherwise only comes back on the first consent.
    prompt: "consent",
    include_granted_scopes: true,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, encrypt(JSON.stringify({ state, codeVerifier })), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/google",
    maxAge: 10 * 60,
  });
  return res;
}
