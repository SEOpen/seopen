import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { db } from "@/db";
import { oauthConsents, oauthRefreshTokens, verifications } from "@/db/schema";

/**
 * Checks the OAuth provider doesn't make itself, run from the auth `before` hook (./index.ts) ahead
 * of its token and authorize endpoints.
 *
 * The provider's token endpoint never looks at the consent. A code or refresh token is tied to the
 * consent it came from only by Disconnect deleting the rows that exist at that moment
 * (`disconnectApp`, src/lib/mcp/oauth.ts, and `revokeAgentAccess`). A row written just after, by a
 * request already under way, outlived the Disconnect and worked again once the same app was
 * connected anew. So every swap and every refresh is checked here against a standing consent.
 */

/** How the provider stores a code or a refresh token (`storeTokens: "hashed"`, its default): SHA-256, base64url, no padding. */
const stored = (token: string) => createHash("sha256").update(token).digest("base64url");

/** Whole seconds, as the provider dates a consent, a code and a refresh token. */
const second = (at: Date) => Math.floor(at.getTime() / 1000);

const refuse = (): never => {
  throw new APIError("BAD_REQUEST", { error: "invalid_grant", error_description: "This app is no longer connected. Connect it again." });
};

/** Whether a consent stands for this app, account and workspace that is no newer than the row dated `issuedAt`. */
async function consentCovers(clientId: string | null | undefined, userId: string | null | undefined, referenceId: string | null | undefined, issuedAt: Date | null | undefined): Promise<boolean> {
  if (!clientId || !userId || !referenceId || !issuedAt) return false;
  const [consent] = await db
    .select({ createdAt: oauthConsents.createdAt })
    .from(oauthConsents)
    .where(and(eq(oauthConsents.clientId, clientId), eq(oauthConsents.userId, userId), eq(oauthConsents.referenceId, referenceId)))
    .limit(1);
  // A row from before the consent belongs to an earlier connection, one that was cut off.
  return Boolean(consent?.createdAt) && second(issuedAt) >= second(consent!.createdAt!);
}

/**
 * Refuses a code swap or a refresh that no standing consent covers, with `invalid_grant`, and
 * deletes the code or refresh token it was for. A token or code the provider doesn't know is left
 * for the provider to refuse in its own words.
 */
export async function requireStandingConsent(body: unknown): Promise<void> {
  const form = (body ?? {}) as Record<string, unknown>;
  if (form.grant_type === "refresh_token" && typeof form.refresh_token === "string") {
    const [row] = await db
      .select({ id: oauthRefreshTokens.id, clientId: oauthRefreshTokens.clientId, userId: oauthRefreshTokens.userId, referenceId: oauthRefreshTokens.referenceId, createdAt: oauthRefreshTokens.createdAt })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.token, stored(form.refresh_token)));
    if (!row || (await consentCovers(row.clientId, row.userId, row.referenceId, row.createdAt))) return;
    await db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.id, row.id));
    refuse();
  }
  if (form.grant_type === "authorization_code" && typeof form.code === "string") {
    const [row] = await db
      .select({ id: verifications.id, value: verifications.value, createdAt: verifications.createdAt })
      .from(verifications)
      .where(eq(verifications.identifier, stored(form.code)));
    if (!row) return;
    const code = parseCode(row.value);
    // Not a code: nothing of this check's, whatever shares the identifier.
    if (!code) return;
    if (await consentCovers(code.clientId, code.userId, code.referenceId, row.createdAt)) return;
    await db.delete(verifications).where(eq(verifications.id, row.id));
    refuse();
  }
}

/** The app, account and workspace an authorization code was written for, from the JSON the provider keeps. */
function parseCode(value: string): { clientId?: string; userId?: string; referenceId?: string } | null {
  try {
    const parsed = JSON.parse(value) as { type?: unknown; query?: { client_id?: unknown }; userId?: unknown; referenceId?: unknown };
    if (parsed?.type !== "authorization_code") return null;
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { clientId: text(parsed.query?.client_id), userId: text(parsed.userId), referenceId: text(parsed.referenceId) };
  } catch {
    return null;
  }
}

/** Hosts an app on the same machine listens on for its callback (RFC 8252 section 7.3). */
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a redirect URI goes to the machine itself, not to a site: an http loopback callback, or an app's own scheme (`cursor://`). */
export function localRedirect(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return false;
    return u.protocol === "http:" ? LOOPBACK_HOSTS.has(u.hostname) : true;
  } catch {
    return false;
  }
}

/**
 * The `prompt` an authorize request goes on with, or null to leave it alone.
 *
 * The provider reuses a stored consent without asking whenever the same app asks again. That is
 * sound for an app with a fixed https callback, which only that site receives. A callback on the
 * machine itself proves nothing about who is listening: any program there can name a connected
 * app's client ID and any loopback port, and would be handed a code with no page shown. So an app
 * with such a callback asks every time (RFC 8252 section 8.6). The consent page's answer goes back
 * through the provider with this prompt removed, so one approval finishes the connection.
 */
export function promptForAuthorize(query: unknown): string | null {
  const q = (query ?? {}) as Record<string, unknown>;
  if (!localRedirect(q.redirect_uri)) return null;
  const asked = new Set(typeof q.prompt === "string" ? q.prompt.split(" ").filter(Boolean) : []);
  // It asked for no page at all, and this request can't go without one.
  if (asked.has("none")) throw new APIError("BAD_REQUEST", { error: "consent_required", error_description: "This app has to ask each time it connects." });
  if (asked.has("consent")) return null;
  return [...asked, "consent"].join(" ");
}
