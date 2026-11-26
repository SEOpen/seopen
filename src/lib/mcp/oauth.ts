import { and, desc, eq, isNull, like, lt, or, sql } from "drizzle-orm";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { db } from "@/db";
import { oauthAccessTokens, oauthClients, oauthConnections, oauthConsents, oauthRefreshTokens, users, verifications, workspaceMembers, workspaces } from "@/db/schema";
import { auth, authBaseUrl } from "@/lib/auth";
import { MCP_SCOPES, mcpResource, OAUTH_SCOPES, oauthIssuer, WORKSPACE_CLAIM, workspaceOfUser } from "@/lib/auth/oauth";
import { LOOPBACK_HOSTS } from "@/lib/auth/oauth-grants";
import type { WorkspaceScope } from "@/lib/workspace";
import type { Principal } from "./keys";

/**
 * The MCP endpoint's side of OAuth (the authorization server
 * is src/lib/auth/oauth.ts). An access token is a JWT signed with the app's own keys, for the MCP
 * endpoint and nothing else. Its signature, issuer, audience and expiry are checked first, then, on
 * every call, what a key gets checked: the consent behind it still stands for that workspace, the
 * user is still a member, and the workspace is active. Disconnecting an app on the MCP page deletes
 * the consent, so its tokens stop at the next call, before they expire.
 */

/** Last-used times are written at most this often, as for keys. */
const TOUCH_EVERY_MS = 60_000;

/** Keeps the signing keys a minute between reads (better-auth/oauth2 caches by this object). */
const JWKS_CACHE = {};

type Claims = { sub?: unknown; azp?: unknown; client_id?: unknown; scope?: unknown; exp?: unknown; iat?: unknown; cnf?: unknown; [WORKSPACE_CLAIM]?: unknown };

async function verifiedClaims(token: string): Promise<Claims | null> {
  const base = authBaseUrl();
  try {
    return (await verifyJwsAccessToken(token, {
      jwksFetch: () => auth.api.getJwks(),
      jwksCacheKey: JWKS_CACHE,
      verifyOptions: { issuer: oauthIssuer(base), audience: mcpResource(base), typ: "at+jwt" },
    })) as Claims;
  } catch {
    return null;
  }
}

/**
 * The principal for an OAuth access token, or null when the token is forged, expired or for
 * another audience, its consent was withdrawn, its user left the workspace, the workspace is
 * suspended, or the app was disabled.
 */
export async function verifyOAuthToken(token: string, now = new Date()): Promise<Principal | null> {
  const claims = await verifiedClaims(token);
  if (!claims) return null;
  // A DPoP-bound token is only good with its proof, which this endpoint doesn't check.
  if (claims.cnf) return null;
  const userId = claims.sub;
  const clientId = claims.azp ?? claims.client_id;
  const workspaceId = claims[WORKSPACE_CLAIM];
  if (typeof userId !== "string" || typeof clientId !== "string" || typeof claims.scope !== "string" || typeof claims.exp !== "number") return null;
  if (typeof workspaceId !== "number" || !Number.isInteger(workspaceId)) return null;

  const [row] = await db
    .select({ scopes: oauthConsents.scopes, consentAt: oauthConsents.createdAt, name: oauthClients.name, disabled: oauthClients.disabled, status: workspaces.status, member: workspaceMembers.userId })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceId))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .where(and(eq(oauthConsents.clientId, clientId), eq(oauthConsents.userId, userId), eq(oauthConsents.referenceId, String(workspaceId))))
    .limit(1);
  if (!row || row.disabled || row.status !== "active" || !row.member) return null;
  // Access tokens aren't stored one by one, so a token from before a Disconnect would pass again once
  // the same app is connected anew. The provider dates a consent in whole seconds, as a token's iat.
  if (typeof claims.iat !== "number" || !row.consentAt || claims.iat < Math.floor(row.consentAt.getTime() / 1000)) return null;

  // What the token says it may do, and only what the consent still allows: a narrower consent
  // given since takes effect before the token expires.
  const granted = new Set(row.scopes);
  const scopes = MCP_SCOPES.filter((s) => granted.has(s) && claims.scope!.toString().split(" ").includes(s));
  if (!scopes.includes("read")) return null;

  const connectionId = await touchConnection({ workspaceId, userId, clientId }, now);
  return {
    workspaceId,
    userId,
    scopes,
    expiresAt: new Date(claims.exp * 1000),
    via: { kind: "app", connectionId, clientId, name: row.name ?? null },
  };
}

/** The connection's id, made on first use, with its last use written at most once a minute. */
async function touchConnection(key: { workspaceId: number; userId: string; clientId: string }, now: Date): Promise<number> {
  const stale = new Date(now.getTime() - TOUCH_EVERY_MS);
  const [row] = await db
    .insert(oauthConnections)
    .values({ ...key, lastUsedAt: now })
    .onConflictDoUpdate({
      target: [oauthConnections.workspaceId, oauthConnections.userId, oauthConnections.clientId],
      set: { lastUsedAt: now },
      setWhere: or(isNull(oauthConnections.lastUsedAt), lt(oauthConnections.lastUsedAt, stale)),
    })
    .returning({ id: oauthConnections.id });
  if (row) return row.id;
  const [existing] = await db
    .select({ id: oauthConnections.id })
    .from(oauthConnections)
    .where(and(eq(oauthConnections.workspaceId, key.workspaceId), eq(oauthConnections.userId, key.userId), eq(oauthConnections.clientId, key.clientId)));
  return existing.id;
}

export type ConsentRequest = {
  clientId: string;
  /** What the app calls itself. It chose this name, so the page also shows where it sends you back. */
  name: string | null;
  /** The host the browser goes back to with the code. */
  redirectHost: string;
  /** For an app known by its client ID metadata document, the host serving that document. */
  metadataHost: string | null;
  /** The scopes it asked for that SEOpen has, in order. */
  scopes: string[];
};

/**
 * The request behind the consent page's address, or null when the address wasn't signed by this
 * server or has expired (10 minutes). Only the signed parameters count, as the provider's own
 * client takes them (`ba_param` lists their names).
 */
export async function readConsentRequest(search: URLSearchParams): Promise<ConsentRequest | null> {
  const names = new Set(search.getAll("ba_param"));
  if (!search.has("sig") || names.size === 0) return null;
  const signed = new URLSearchParams();
  for (const [k, v] of search) if (k === "sig" || k === "ba_param" || names.has(k)) signed.append(k, v);
  const { secret } = await auth.$context;
  if (!(await verifyOAuthQueryParams(signed.toString(), secret))) return null;

  const clientId = signed.get("client_id");
  const redirectUri = signed.get("redirect_uri");
  if (!clientId || !redirectUri) return null;
  const [client] = await db
    .select({ name: oauthClients.name, redirectUris: oauthClients.redirectUris, disabled: oauthClients.disabled, discovery: oauthClients.clientDiscoveryId })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  if (!client || client.disabled || !client.redirectUris.some((uri) => sameRedirect(uri, redirectUri))) return null;

  const asked = new Set((signed.get("scope") ?? "").split(" "));
  return {
    clientId,
    name: client.name,
    redirectHost: hostOf(redirectUri),
    metadataHost: client.discovery ? hostOf(clientId) : null,
    scopes: OAUTH_SCOPES.filter((s) => asked.has(s)),
  };
}

/** The workspace a consent from this account would be for (`consentReferenceId`'s rule), or null. */
export async function consentWorkspace(userId: string): Promise<{ id: number; name: string; active: boolean } | null> {
  const id = await workspaceOfUser(userId);
  if (id == null) return null;
  const [ws] = await db.select({ id: workspaces.id, name: workspaces.name, status: workspaces.status }).from(workspaces).where(eq(workspaces.id, id));
  return ws ? { id: ws.id, name: ws.name, active: ws.status === "active" } : null;
}

/**
 * Whether a requested redirect URI matches a registered one, by the provider's own rule
 * (`findRegisteredRedirectUri` in @better-auth/oauth-provider, RFC 8252 section 7.3): exactly, or
 * for an http loopback callback, with only the port different. Native apps such as Claude Code
 * listen on whatever port is free, so the port they register isn't the one they come back on.
 */
export function sameRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const strip = (uri: string) => {
    try {
      const u = new URL(uri);
      if (u.protocol !== "http:" || !LOOPBACK_HOSTS.has(u.hostname) || u.username || u.password || uri.includes("#")) return null;
      u.port = "";
      return u.href;
    } catch {
      return null;
    }
  };
  const a = strip(registered);
  return a !== null && a === strip(requested);
}

/** A URL's host, or its scheme for an app's own scheme (`cursor://`), which has none. */
function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host || `${u.protocol}//`;
  } catch {
    return url;
  }
}

/** The apps connected to the workspace over OAuth, newest first: one row per person who connected each. */
export function listConnectedApps(scope: WorkspaceScope) {
  return db
    .select({
      id: oauthConsents.id,
      clientId: oauthConsents.clientId,
      name: oauthClients.name,
      uri: oauthClients.uri,
      userId: oauthConsents.userId,
      email: users.email,
      scopes: oauthConsents.scopes,
      createdAt: oauthConsents.createdAt,
      lastUsedAt: oauthConnections.lastUsedAt,
    })
    .from(oauthConsents)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
    .leftJoin(users, eq(users.id, oauthConsents.userId))
    .leftJoin(
      oauthConnections,
      and(
        eq(oauthConnections.workspaceId, scope.workspaceId),
        eq(oauthConnections.clientId, oauthConsents.clientId),
        eq(oauthConnections.userId, oauthConsents.userId),
      ),
    )
    .where(eq(oauthConsents.referenceId, String(scope.workspaceId)))
    .orderBy(desc(oauthConsents.createdAt), desc(oauthConsents.id));
}

/**
 * How the provider's JSON for an authorization code starts: `JSON.stringify({ type: "authorization_code", ... })`.
 * A LIKE pattern, so the `_` is escaped (backslash is LIKE's default escape) to match only itself.
 */
const CODE_PREFIX = '{"type":"authorization\\_code",%';

/**
 * Disconnects one of the workspace's apps: its consent, its refresh tokens, the authorization codes
 * it hasn't swapped yet, and SEOpen's record of it. Its access tokens stop working at the next call,
 * and the app has to ask again. False when the consent isn't the workspace's or is already gone.
 *
 * The codes go because swapping one doesn't look at the consent: a code from before the Disconnect,
 * swapped in its 10 minutes after the same app connects again, would get fresh tokens dated after
 * the new consent. The provider keeps a code in `verifications` as the JSON it wrote, which always
 * starts with its type; only rows that start that way are read as JSON, since other values there
 * needn't be JSON.
 */
export async function disconnectApp(scope: WorkspaceScope, consentId: string): Promise<boolean> {
  if (!consentId) return false;
  const ref = String(scope.workspaceId);
  return db.transaction(async (tx) => {
    const [consent] = await tx
      .delete(oauthConsents)
      .where(and(eq(oauthConsents.id, consentId), eq(oauthConsents.referenceId, ref)))
      .returning({ clientId: oauthConsents.clientId, userId: oauthConsents.userId });
    if (!consent?.userId) return Boolean(consent);
    const { clientId, userId } = consent;
    await tx.delete(oauthRefreshTokens).where(and(eq(oauthRefreshTokens.clientId, clientId), eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.referenceId, ref)));
    await tx.delete(oauthAccessTokens).where(and(eq(oauthAccessTokens.clientId, clientId), eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.referenceId, ref)));
    await tx.delete(oauthConnections).where(and(eq(oauthConnections.workspaceId, scope.workspaceId), eq(oauthConnections.clientId, clientId), eq(oauthConnections.userId, userId)));
    const code = sql`(case when ${verifications.value} like ${CODE_PREFIX} then ${verifications.value}::jsonb end)`;
    await tx
      .delete(verifications)
      .where(
        and(
          like(verifications.value, CODE_PREFIX),
          sql`${code}->'query'->>'client_id' = ${clientId}`,
          sql`${code}->>'userId' = ${userId}`,
          sql`${code}->>'referenceId' = ${ref}`,
        ),
      );
    return true;
  });
}
