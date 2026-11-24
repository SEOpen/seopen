import { createHash, randomBytes } from "node:crypto";
import { appOrigin } from "@/lib/hosts";
import { CALLBACK_PATH, CLIENT_METADATA_PATH, REGIONS, SCOPES, type Region } from "./types";

/**
 * PostHog OAuth with a Client ID Metadata Document (https://posthog.com/docs/api/oauth): SEOpen's
 * client id is the URL of a JSON document it serves, so there is no client secret and nothing to
 * register. PostHog fetches that URL at consent, so it must be public https. Locally it isn't,
 * and the module runs on fixtures instead (SEOPEN_POSTHOG_FIXTURES=1).
 */

export const clientId = () => `${appOrigin()}${CLIENT_METADATA_PATH}`;
export const redirectUri = () => `${appOrigin()}${CALLBACK_PATH}`;

/** True where PostHog can fetch the client metadata, i.e. the app is served over https. */
export const oauthAvailable = () => appOrigin().startsWith("https://");

/** The document served at the client id URL. Every scope in it is required at consent. */
export function clientMetadata() {
  return {
    client_id: clientId(),
    client_name: "SEOpen",
    client_uri: appOrigin(),
    logo_uri: `${appOrigin()}/apple-icon.png`,
    redirect_uris: [redirectUri()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    "com.posthog": { scopes: SCOPES },
  };
}

/** A PKCE verifier and its S256 challenge, plus a state value. */
export function newPkce() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge, state: randomBytes(32).toString("base64url") };
}

export function authorizeUrl(region: Region, p: { state: string; codeChallenge: string }): string {
  const url = new URL("/oauth/authorize/", REGIONS[region]);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: redirectUri(),
    scope: SCOPES.join(" "),
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  /** Project ids the user granted; absent or empty when they granted every project. */
  scoped_teams?: number[];
}

/** An OAuth error response from PostHog, e.g. `invalid_grant` for a revoked refresh token. */
export class PosthogOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`PostHog OAuth error: ${code} (HTTP ${status})`);
  }
}

async function tokenRequest(region: Region, body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  const res = await fetchImpl(new URL("/oauth/token/", REGIONS[region]), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...body, client_id: clientId() }),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string };
  if (!res.ok || !json.access_token) throw new PosthogOAuthError(json.error ?? "token_request_failed", res.status);
  return json;
}

export function exchangeCode(region: Region, code: string, codeVerifier: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest(region, { grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: codeVerifier }, fetchImpl);
}

export function refreshTokens(region: Region, refreshToken: string, fetchImpl: typeof fetch = fetch) {
  return tokenRequest(region, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/** Revokes a token. True when PostHog accepted it or the token was already dead (any 4xx). */
export async function revokeToken(region: Region, token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(new URL("/oauth/revoke/", REGIONS[region]), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: clientId() }),
  });
  return res.ok || (res.status >= 400 && res.status < 500);
}
