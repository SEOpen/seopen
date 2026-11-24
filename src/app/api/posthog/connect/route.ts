import { NextResponse, type NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { encrypt } from "@/lib/crypto";
import { authorizeUrl, newPkce, oauthAvailable } from "@/modules/posthog/oauth";
import { POSTHOG_COOKIE } from "@/modules/posthog/oauth-cookie";
import { isRegion } from "@/modules/posthog/types";

/** Starts PostHog consent for ?region=us|eu: state, PKCE verifier and region go into a short-lived httpOnly cookie. */
export async function GET(request: NextRequest) {
  await requireSession();
  const region = request.nextUrl.searchParams.get("region") ?? "us";
  if (!isRegion(region)) return NextResponse.redirect(new URL("/ga4?posthog_error=bad_region", request.url));
  if (!oauthAvailable()) return NextResponse.redirect(new URL("/ga4?posthog_error=not_configured", request.url));

  const { state, codeVerifier, codeChallenge } = newPkce();
  const res = NextResponse.redirect(authorizeUrl(region, { state, codeChallenge }));
  res.cookies.set(POSTHOG_COOKIE, encrypt(JSON.stringify({ state, codeVerifier, region })), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/posthog",
    maxAge: 10 * 60,
  });
  return res;
}
