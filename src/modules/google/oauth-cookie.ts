import { timingSafeEqual } from "node:crypto";
import { decrypt } from "@/lib/crypto";

/** Holds the OAuth state and PKCE verifier between /api/google/connect and /callback. */
export const OAUTH_COOKIE = "seopen_google_oauth";

export function readOAuthCookie(value: string | undefined): { state: string; codeVerifier: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(decrypt(value));
    return typeof v.state === "string" && typeof v.codeVerifier === "string" ? v : null;
  } catch {
    return null;
  }
}

export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
