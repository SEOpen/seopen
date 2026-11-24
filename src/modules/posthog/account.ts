import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { posthogAccounts } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { PosthogOAuthError, refreshTokens, revokeToken, type TokenResponse } from "./oauth";
import { isRegion, PosthogNotConnectedError, type Region } from "./types";

export type PosthogAccount = typeof posthogAccounts.$inferSelect;

/**
 * Development switch: SEOPEN_POSTHOG_FIXTURES=1 in .env.local serves generated data instead of
 * calling PostHog. Local dev needs it: PostHog can't fetch an http://127.0.0.1 client id.
 */
export function fixtureMode(): boolean {
  return process.env.SEOPEN_POSTHOG_FIXTURES === "1";
}

/** Refresh this long before the access token expires, so a sync never starts on a dying token. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const DEFAULT_LIFETIME_S = 3600;

export async function getPosthogAccount(workspaceId: number): Promise<PosthogAccount | null> {
  const [row] = await db.select().from(posthogAccounts).where(eq(posthogAccounts.workspaceId, workspaceId));
  return row ?? null;
}

const ownRow = (a: Pick<PosthogAccount, "id" | "workspaceId">) => and(eq(posthogAccounts.id, a.id), eq(posthogAccounts.workspaceId, a.workspaceId));

const tokenFields = (t: TokenResponse, previousRefresh?: string | null) => ({
  accessTokenEnc: encrypt(t.access_token),
  // A refresh that returns no new refresh token keeps the old one.
  refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token) : (previousRefresh ?? null),
  accessTokenExpiresAt: new Date(Date.now() + (t.expires_in ?? DEFAULT_LIFETIME_S) * 1000),
  lastRefreshAt: new Date(),
  lastError: null,
  status: "active",
});

/** Stores a finished consent as the workspace's connection, replacing its previous one. */
export async function savePosthogAccount(workspaceId: number, region: Region, t: TokenResponse) {
  const values = {
    workspaceId,
    region,
    ...tokenFields(t),
    scopes: (t.scope ?? "").split(/\s+/).filter(Boolean),
    scopedTeams: (t.scoped_teams ?? []).filter((n) => Number.isInteger(n)),
    connectedAt: new Date(),
  };
  await db.insert(posthogAccounts).values(values).onConflictDoUpdate({ target: posthogAccounts.workspaceId, set: values });
}

/**
 * Revokes the workspace's tokens at PostHog, then forgets the connection. The row is kept when
 * PostHog can't be reached, so a live grant is never left orphaned.
 */
export async function disconnectPosthogAccount(workspaceId: number, fetchImpl: typeof fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const account = await getPosthogAccount(workspaceId);
  if (!account) return { ok: true };
  if (isRegion(account.region) && !fixtureMode()) {
    try {
      const tokens = [account.refreshTokenEnc, account.accessTokenEnc].filter((t): t is string => !!t).map(decrypt);
      for (const t of tokens) {
        if (!(await revokeToken(account.region, t, fetchImpl))) throw new Error("PostHog returned a server error");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await db.update(posthogAccounts).set({ lastError: `Revoke failed: ${error}` }).where(ownRow(account));
      return { ok: false, error };
    }
  }
  await db.delete(posthogAccounts).where(ownRow(account));
  return { ok: true };
}

async function markReauth(account: PosthogAccount, lastError: string) {
  await db.update(posthogAccounts).set({ status: "reauth_required", lastError }).where(ownRow(account));
}

/**
 * A live access token for the workspace's connection, refreshed when it is about to expire.
 * A refused refresh (or none to use) flips the connection to "reauth_required".
 */
export async function posthogAccessToken(workspaceId: number, fetchImpl: typeof fetch = fetch): Promise<{ token: string; account: PosthogAccount }> {
  const account = await getPosthogAccount(workspaceId);
  if (!account) throw new PosthogNotConnectedError("not_connected");
  if (account.status === "reauth_required" || !isRegion(account.region)) throw new PosthogNotConnectedError("reauth_required");
  if (account.accessTokenExpiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return { token: decrypt(account.accessTokenEnc), account };

  if (!account.refreshTokenEnc) {
    await markReauth(account, "The access token expired and PostHog issued no refresh token");
    throw new PosthogNotConnectedError("reauth_required");
  }
  try {
    const t = await refreshTokens(account.region, decrypt(account.refreshTokenEnc), fetchImpl);
    const set = tokenFields(t, account.refreshTokenEnc);
    await db.update(posthogAccounts).set(set).where(ownRow(account));
    return { token: t.access_token, account: { ...account, ...set } };
  } catch (err) {
    // A refused grant needs the user; anything else (network, 5xx) is worth a retry later.
    if (err instanceof PosthogOAuthError && err.status >= 400 && err.status < 500) {
      await markReauth(account, `${err.code}: the refresh token was refused`);
      throw new PosthogNotConnectedError("reauth_required");
    }
    throw err;
  }
}

/** Called when the API rejects a token we believed was live (revoked in PostHog's settings). */
export async function rejectPosthogToken(account: PosthogAccount) {
  await markReauth(account, "PostHog rejected the access token (revoked or expired)");
}
