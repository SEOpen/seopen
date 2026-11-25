import { timingSafeEqual } from "node:crypto";
import { decrypt } from "@/lib/crypto";

/**
 * Holds the OAuth state, PKCE verifier and the account that started between /api/google/connect and
 * /callback. The callback connects the workspace of whoever is signed in when Google answers, so it
 * finishes only for that account.
 */
export const OAUTH_COOKIE = "seopen_google_oauth";

export function readOAuthCookie(value: string | undefined): { state: string; codeVerifier: string; userId: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(decrypt(value));
    return typeof v.state === "string" && typeof v.codeVerifier === "string" && typeof v.userId === "string" ? v : null;
  } catch {
    return null;
  }
}

export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
