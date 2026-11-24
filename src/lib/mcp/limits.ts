import { lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiKeyUsage, oauthConnectionUsage } from "@/db/schema";
import type { Principal } from "./keys";

/**
 * Per-key rate limits for the MCP server, counted in
 * Postgres in fixed windows so every instance shares them. `requests` bounds an agent stuck in a
 * loop; `changes` bounds what one key can add or start in an hour, `research` what it can buy and
 * `inspections` how much of a property's 2,000 daily Google URL inspections it can use, on top
 * of the plan's limits and the spend gates. An app connected over OAuth has the same limits, counted
 * per connection in `oauth_connection_usage`.
 */
export const LIMITS = {
  requests: { max: 120, windowMs: 60_000, what: "120 requests a minute" },
  changes: { max: 30, windowMs: 60 * 60_000, what: "30 changes an hour" },
  research: { max: 60, windowMs: 60 * 60_000, what: "60 paid lookups an hour" },
  inspections: { max: 100, windowMs: 60 * 60_000, what: "100 URL inspections an hour" },
} as const;

export type LimitBucket = keyof typeof LIMITS;

export type LimitResult = { ok: true } | { ok: false; retryAfterS: number; message: string };

/** Counts one use of `bucket` for the key or connection and says whether it was within the limit. */
export async function consumeLimit(principal: Pick<Principal, "via" | "workspaceId">, bucket: LimitBucket, now = new Date()): Promise<LimitResult> {
  const { max, windowMs, what } = LIMITS[bucket];
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const { via, workspaceId } = principal;
  const [row] =
    via.kind === "key"
      ? await db
          .insert(apiKeyUsage)
          .values({ keyId: via.keyId, workspaceId, bucket, windowStart, count: 1 })
          .onConflictDoUpdate({ target: [apiKeyUsage.keyId, apiKeyUsage.bucket, apiKeyUsage.windowStart], set: { count: sql`${apiKeyUsage.count} + 1` } })
          .returning({ count: apiKeyUsage.count })
      : await db
          .insert(oauthConnectionUsage)
          .values({ connectionId: via.connectionId, workspaceId, bucket, windowStart, count: 1 })
          .onConflictDoUpdate({
            target: [oauthConnectionUsage.connectionId, oauthConnectionUsage.bucket, oauthConnectionUsage.windowStart],
            set: { count: sql`${oauthConnectionUsage.count} + 1` },
          })
          .returning({ count: oauthConnectionUsage.count });
  if (row.count <= max) return { ok: true };
  const retryAfterS = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
  const who = via.kind === "key" ? "This API key" : "This connected app";
  return { ok: false, retryAfterS, message: `${who} is limited to ${what}. Try again in ${retryAfterS} seconds.` };
}

/** Drops counters more than a day old (the longest window is an hour). Run daily. */
export async function pruneLimitCounters(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
  const [keys, apps] = await Promise.all([
    db.delete(apiKeyUsage).where(lt(apiKeyUsage.windowStart, cutoff)).returning({ keyId: apiKeyUsage.keyId }),
    db.delete(oauthConnectionUsage).where(lt(oauthConnectionUsage.windowStart, cutoff)).returning({ id: oauthConnectionUsage.connectionId }),
  ]);
  return keys.length + apps.length;
}
