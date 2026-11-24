import { and, eq } from "drizzle-orm";
import { OAuth2Client } from "google-auth-library";
import { db } from "@/db";
import { googleAccounts } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { GoogleNotConnectedError, GoogleQuotaError, REQUIRED_SCOPES, SCOPE_WEBMASTERS, SCOPE_WEBMASTERS_FULL } from "./types";

export type GoogleAccount = typeof googleAccounts.$inferSelect;

/**
 * Development switch: SEOPEN_GOOGLE_FIXTURES=1 in .env.local serves generated data instead of
 * calling Google, so the module can be built and checked before an account is connected.
 */
export function fixtureMode(): boolean {
  return process.env.SEOPEN_GOOGLE_FIXTURES === "1";
}

export function oauthConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
}

export function newOAuthClient(): OAuth2Client {
  const e = env();
  if (!oauthConfigured()) throw new GoogleNotConnectedError("not_configured");
  return new OAuth2Client({ clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, redirectUri: e.GOOGLE_REDIRECT_URI });
}

/** The workspace's Google connection (one per workspace), or null. */
export async function getAccount(workspaceId: number): Promise<GoogleAccount | null> {
  const [row] = await db.select().from(googleAccounts).where(eq(googleAccounts.workspaceId, workspaceId));
  return row ?? null;
}

export function missingScopes(account: Pick<GoogleAccount, "scopes">): string[] {
  const granted = new Set(account.scopes);
  if (granted.has(SCOPE_WEBMASTERS_FULL)) granted.add(SCOPE_WEBMASTERS);
  return REQUIRED_SCOPES.filter((s) => !granted.has(s));
}

/**
 * Stores the account from a finished consent as the workspace's connection, replacing that
 * workspace's previous one (if any). Other workspaces' connections are never touched, even when
 * they connected the same Google account.
 */
export async function saveAccount(workspaceId: number, input: {
  email: string;
  googleSub: string;
  refreshToken: string;
  scopes: string[];
  refreshTokenExpiresInSeconds?: number | null;
}) {
  const values = {
    workspaceId,
    email: input.email,
    googleSub: input.googleSub,
    refreshTokenEnc: encrypt(input.refreshToken),
    scopes: input.scopes,
    status: "active",
    refreshTokenExpiresAt: input.refreshTokenExpiresInSeconds ? new Date(Date.now() + input.refreshTokenExpiresInSeconds * 1000) : null,
    connectedAt: new Date(),
    lastRefreshAt: new Date(),
    lastError: null,
  };
  await db.insert(googleAccounts).values(values).onConflictDoUpdate({ target: googleAccounts.workspaceId, set: values });
}

/**
 * Revokes the workspace's refresh token at Google, then forgets the account. The row is kept when
 * the revoke fails for another reason (network, Google down), so the grant is never left live and
 * orphaned.
 */
export async function disconnectAccount(workspaceId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = await getAccount(workspaceId);
  if (!account) return { ok: true };
  if (oauthConfigured()) {
    try {
      await newOAuthClient().revokeToken(decrypt(account.refreshTokenEnc));
    } catch (err) {
      // Already revoked or expired: nothing left to revoke.
      if (!isInvalidGrant(err) && !/invalid_token/.test(errorText(err))) {
        const error = err instanceof Error ? err.message : String(err);
        await db.update(googleAccounts).set({ lastError: `Revoke failed: ${error}` }).where(ownRow(account));
        return { ok: false, error };
      }
    }
  }
  await db.delete(googleAccounts).where(ownRow(account));
  return { ok: true };
}

/** The account's own row: matched on its workspace too, so a write can only hit that workspace's connection. */
const ownRow = (a: Pick<GoogleAccount, "id" | "workspaceId">) => and(eq(googleAccounts.id, a.id), eq(googleAccounts.workspaceId, a.workspaceId));

/**
 * An OAuth client for the workspace's connected account. The library refreshes the access token
 * on demand; a rotated refresh token is re-encrypted and stored.
 */
export async function authorizedClient(workspaceId: number): Promise<{ client: OAuth2Client; account: GoogleAccount }> {
  const account = await getAccount(workspaceId);
  if (!account) throw new GoogleNotConnectedError("not_connected");
  if (account.status === "reauth_required") throw new GoogleNotConnectedError("reauth_required");
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: decrypt(account.refreshTokenEnc) });
  client.on("tokens", (t) => {
    const set: Partial<GoogleAccount> = { lastRefreshAt: new Date(), lastError: null };
    if (t.refresh_token) set.refreshTokenEnc = encrypt(t.refresh_token);
    void db.update(googleAccounts).set(set).where(ownRow(account)).catch(() => {});
  });
  return { client, account };
}

function errorText(err: unknown): string {
  const e = err as { message?: string; response?: { data?: unknown } };
  const data = e.response?.data ? JSON.stringify(e.response.data) : "";
  return `${e.message ?? String(err)} ${data}`;
}

export function isInvalidGrant(err: unknown): boolean {
  return /invalid_grant/.test(errorText(err));
}

const httpStatus = (err: unknown) => (err as { status?: number; response?: { status?: number } }).response?.status ?? (err as { status?: number }).status;

export function isQuotaError(err: unknown): boolean {
  return httpStatus(err) === 429 || /quota|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(errorText(err));
}

/**
 * Google said no to this account (HTTP 403), e.g. it lost access to the property. The token itself
 * still works, so the connection stays as it is, and the same call fails until the access changes.
 * The message is Google's own, for the logs.
 */
export class GoogleAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAccessError";
  }
}

/**
 * Google failed on its side (HTTP 5xx), or answered with a web page instead of an API error. It
 * passes, so jobs retry as usual. The message is short: the library makes a non-JSON body the
 * error's message, and Google's 502 page is 1.6k characters of HTML that ended up in Admin → Health.
 */
export class GoogleServerError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(message);
    this.name = "GoogleServerError";
  }
}

const MAX_MESSAGE = 300;

/** Google's own text when it is a short API message, else the status and the page's reason ("Server Error"). */
export function shortGoogleMessage(err: unknown): string {
  const message = (err as { message?: string }).message ?? String(err);
  const status = httpStatus(err);
  if (!/<html|<!doctype/i.test(message)) return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
  const title = /<title>([^<]*)<\/title>/i.exec(message)?.[1] ?? "";
  const reason = /\(([^)]+)\)/.exec(title)?.[1] ?? (err as { response?: { statusText?: string } }).response?.statusText;
  return `Google returned ${status ? `HTTP ${status}` : "an error page"}${reason ? ` (${reason})` : ""}`;
}

/**
 * Translates Google errors for callers: a revoked token flips the account to
 * "reauth_required" (and is not retried, since each re-consent mints a new token);
 * a 5xx or an HTML page becomes GoogleServerError with a short message (Google never sends quota
 * errors as 5xx, so this comes before the quota check, whose pattern would otherwise run over a
 * whole page); quota errors become GoogleQuotaError so jobs can back off, and any other 403
 * (Google also sends quota errors as 403s, so this comes after) becomes GoogleAccessError.
 */
export async function classifyGoogleError(err: unknown, accountId?: number): Promise<never> {
  if (isInvalidGrant(err)) {
    if (accountId) {
      await db
        .update(googleAccounts)
        .set({ status: "reauth_required", lastError: "invalid_grant: refresh token revoked or expired" })
        .where(eq(googleAccounts.id, accountId));
    }
    throw new GoogleNotConnectedError("reauth_required");
  }
  const status = httpStatus(err);
  const message = (err as { message?: string }).message ?? "";
  if ((status !== undefined && status >= 500) || /<html|<!doctype/i.test(message)) throw new GoogleServerError(status, shortGoogleMessage(err));
  if (isQuotaError(err)) throw new GoogleQuotaError((err as Error).message ?? "Quota exceeded");
  if (status === 403) throw new GoogleAccessError((err as Error).message ?? "Google refused access");
  throw err;
}
