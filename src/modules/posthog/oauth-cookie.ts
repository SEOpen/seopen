import { decrypt } from "@/lib/crypto";
import { isRegion, type Region } from "./types";

/**
 * Holds the OAuth state, PKCE verifier, region and the account that started between
 * /api/posthog/connect and /callback, which finishes only for that account.
 */
export const POSTHOG_COOKIE = "seopen_posthog_oauth";

export function readPosthogCookie(value: string | undefined): { state: string; codeVerifier: string; region: Region; userId: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(decrypt(value));
    return typeof v.state === "string" && typeof v.codeVerifier === "string" && typeof v.userId === "string" && isRegion(v.region) ? v : null;
  } catch {
    return null;
  }
}
