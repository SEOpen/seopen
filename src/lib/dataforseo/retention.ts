import { and, eq, gte, inArray, lt, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiCache, apiCacheAccess } from "@/db/schema";
import { deleteInBatches } from "@/lib/purge";

/**
 * Deletes cached DataForSEO responses past their expiry, and the api_cache_access rows of responses
 * that are gone or expired (the daily billing.alerts job). Every read of a response as a hit
 * (`readCache`, `recentLookups`) skips an expired row, and saving a fresh one rewrites the row and
 * clears its access rows, so neither is read again. The only other read of an expired row is
 * `cacheWrittenAt`, which tells whether another call saved the key meanwhile; with the row gone it
 * reads null and the call saves its answer, as it would over the expired row. Runs in the worker.
 */
export async function purgeExpiredCache(now = new Date()): Promise<{ cache: number; access: number }> {
  const cache = await deleteInBatches(async (limit) => {
    const batch = db.select({ key: apiCache.key }).from(apiCache).where(lt(apiCache.expiresAt, now)).limit(limit);
    const rows = await db.delete(apiCache).where(inArray(apiCache.key, batch)).returning({ key: apiCache.key });
    return rows.length;
  });
  // api_cache_access has no foreign key to api_cache, so a workspace delete or the free tools' purge also leaves rows with no response at all.
  const live = db.select({ key: apiCache.key }).from(apiCache).where(and(eq(apiCache.key, apiCacheAccess.key), gte(apiCache.expiresAt, now)));
  const access = await deleteInBatches(async (limit) => {
    const batch = db
      .select({ key: apiCacheAccess.key, workspaceId: apiCacheAccess.workspaceId })
      .from(apiCacheAccess)
      .where(and(lt(apiCacheAccess.paidAt, now), notExists(live)))
      .limit(limit);
    const rows = await db
      .delete(apiCacheAccess)
      .where(sql`(${apiCacheAccess.key}, ${apiCacheAccess.workspaceId}) in ${batch}`)
      .returning({ key: apiCacheAccess.key });
    return rows.length;
  });
  return { cache, access };
}
