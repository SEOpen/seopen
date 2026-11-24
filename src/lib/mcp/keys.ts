import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, workspaceMembers, workspaces } from "@/db/schema";
import type { WorkspaceScope } from "@/lib/workspace";

/**
 * Workspace API keys for the MCP server. A key is
 * `seopen_` plus 32 random bytes in base64url. Only its SHA-256 is stored, so a plain hash lookup
 * is enough: the key has too much entropy to guess or brute-force.
 */

export const KEY_PREFIX = "seopen_";
/** Characters of the key kept in clear, so the MCP page can tell keys apart. */
const SHOWN_CHARS = KEY_PREFIX.length + 5;
/** Last-used times are written at most this often, so busy keys don't write on every call. */
const TOUCH_EVERY_MS = 60_000;

export const MAX_KEY_NAME = 80;

/** Who a verified key or connected app acts for. Tools get only this, never a cookie or session. */
export interface Principal extends WorkspaceScope {
  userId: string;
  scopes: string[];
  expiresAt: Date | null;
  /** What the call came in on: a workspace API key, or an app connected over OAuth (./oauth.ts). Rate limits count per each. */
  via: { kind: "key"; keyId: number } | { kind: "app"; connectionId: number; clientId: string; name: string | null };
}

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function looksLikeKey(token: string): boolean {
  return token.startsWith(KEY_PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(token.slice(KEY_PREFIX.length));
}

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Every key reads. `write` lets an agent create projects, add keywords, prompts and listings, and start checks.
 * An app connected over OAuth gets the same scopes, by the same names, from its consent.
 */
export const WRITE_SCOPE = "write";

export const canWrite = (p: Pick<Principal, "scopes">) => p.scopes.includes(WRITE_SCOPE);

/** `research` lets an agent spend research credits on lookups, within what the call's `max_credits` allows. */
export const RESEARCH_SCOPE = "research";

export const canResearch = (p: Pick<Principal, "scopes">) => p.scopes.includes(RESEARCH_SCOPE);

/** Makes a key for a member of the workspace. Returns the key itself, which is never shown again. */
export async function createApiKey(
  owner: WorkspaceScope & { userId: string },
  input: { name: string; expiresAt?: Date | null; write?: boolean; research?: boolean },
): Promise<{ key: string; row: ApiKeyRow }> {
  const name = input.name.trim().slice(0, MAX_KEY_NAME);
  if (!name) throw new Error("Give the key a name, such as “Claude Code on my laptop”.");
  const key = generateKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      name,
      prefix: key.slice(0, SHOWN_CHARS),
      hash: hashKey(key),
      scopes: ["read", ...(input.write ? [WRITE_SCOPE] : []), ...(input.research ? [RESEARCH_SCOPE] : [])],
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  return { key, row };
}

/** The workspace's keys, newest first, revoked ones included. */
export function listApiKeys(scope: WorkspaceScope) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      userId: apiKeys.userId,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, scope.workspaceId))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
}

/** Revokes one of the workspace's keys. False when it isn't the workspace's or was already revoked. */
export async function revokeApiKey(scope: WorkspaceScope, id: number): Promise<boolean> {
  if (!Number.isInteger(id)) return false;
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, scope.workspaceId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/**
 * The principal for a key, or null when the key is unknown, revoked or expired, its creator is no
 * longer a member of the workspace, or the workspace is suspended. Checked on every call.
 */
export async function verifyApiKey(key: string, now = new Date()): Promise<Principal | null> {
  if (!looksLikeKey(key)) return null;
  const [row] = await db
    .select({ key: apiKeys, status: workspaces.status, member: workspaceMembers.userId })
    .from(apiKeys)
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, apiKeys.workspaceId), eq(workspaceMembers.userId, apiKeys.userId)))
    .where(eq(apiKeys.hash, hashKey(key)));
  if (!row || row.key.revokedAt || row.status !== "active" || !row.member) return null;
  if (row.key.expiresAt && row.key.expiresAt <= now) return null;
  if (!row.key.lastUsedAt || now.getTime() - row.key.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id));
  }
  return {
    workspaceId: row.key.workspaceId,
    userId: row.key.userId,
    scopes: row.key.scopes,
    expiresAt: row.key.expiresAt,
    via: { kind: "key", keyId: row.key.id },
  };
}
