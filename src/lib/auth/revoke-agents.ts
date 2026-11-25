import { and, eq, isNull, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, oauthAccessTokens, oauthConnections, oauthConsents, oauthRefreshTokens, verifications } from "@/db/schema";

/** How the provider's JSON for an authorization code starts (src/lib/mcp/oauth.ts, disconnectApp). */
const CODE_PREFIX = '{"type":"authorization\\_code",%';

/**
 * Cuts off every agent a user let in, in every workspace: their MCP API keys are revoked, and each
 * connected app loses its consent, tokens and unswapped codes, as Disconnect does. Password reset
 * calls this: it is how an account is taken back, and a key or refresh token outlives the sessions
 * Better Auth signs out, so whoever held the account could keep working through them. The apps
 * themselves stay registered; connecting again asks for consent. Changing the password calls it too
 * (the after hook in ./index.ts).
 */
export async function revokeAgentAccess(userId: string): Promise<{ keys: number; apps: number }> {
  return db.transaction(async (tx) => {
    const keys = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    const apps = await tx.delete(oauthConsents).where(eq(oauthConsents.userId, userId)).returning({ id: oauthConsents.id });
    await tx.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, userId));
    await tx.delete(oauthAccessTokens).where(eq(oauthAccessTokens.userId, userId));
    await tx.delete(oauthConnections).where(eq(oauthConnections.userId, userId));
    const code = sql`(case when ${verifications.value} like ${CODE_PREFIX} then ${verifications.value}::jsonb end)`;
    await tx.delete(verifications).where(and(like(verifications.value, CODE_PREFIX), sql`${code}->>'userId' = ${userId}`));
    return { keys: keys.length, apps: apps.length };
  });
}
