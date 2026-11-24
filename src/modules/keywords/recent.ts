import "server-only";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiCache, apiCacheAccess } from "@/db/schema";
import { keywordOverviewSpec, type Market } from "./requests";

/** How long a lookup stays listed on the Overview tab. Its metrics are kept 30 days, so opening one stays free. */
export const RECENT_DAYS = 7;
const RECENT_LIMIT = 20;

export interface RecentLookup {
  keyword: string;
  volume: number | null;
  kd: number | null;
  lookedUpAt: Date;
}

/**
 * The keywords this workspace looked up lately in this market, newest first, read from the cached
 * responses it paid for, so it spends nothing and needs no table of its own. Only one-keyword requests
 * count, which leaves out guided setup's and rank tracking's batches. A batch that happens to hold one
 * keyword looks the same and is listed too, which is harmless: it opens for free like any other.
 * It covers the whole workspace, since a keyword lookup belongs to a market and not to a project.
 */
export async function recentLookups(workspaceId: number, m: Market, now = new Date()): Promise<RecentLookup[]> {
  const task = sql`${apiCache.response}`;
  const rows = await db
    .select({
      keyword: sql<string>`${task}#>>'{tasks,0,data,keywords,0}'`,
      volume: sql<number | null>`(${task}#>>'{tasks,0,result,0,items,0,keyword_info,search_volume}')::float8`,
      // A 0 is a keyword Labs hasn't scored, as in knownKd.
      kd: sql<number | null>`nullif((${task}#>>'{tasks,0,result,0,items,0,keyword_properties,keyword_difficulty}')::float8, 0)`,
      lookedUpAt: apiCacheAccess.paidAt,
    })
    .from(apiCacheAccess)
    .innerJoin(apiCache, eq(apiCache.key, apiCacheAccess.key))
    .where(
      and(
        eq(apiCacheAccess.workspaceId, workspaceId),
        eq(apiCache.endpoint, keywordOverviewSpec("", m).path),
        gt(apiCacheAccess.paidAt, new Date(now.getTime() - RECENT_DAYS * 86_400_000)),
        gt(apiCache.expiresAt, now),
        sql`${task}#>>'{tasks,0,data,keywords,0}' is not null`,
        sql`${task}#>>'{tasks,0,data,keywords,1}' is null`,
        sql`${task}#>>'{tasks,0,data,location_code}' = ${String(m.locationCode)}`,
        sql`${task}#>>'{tasks,0,data,language_code}' = ${m.languageCode}`,
      ),
    )
    .orderBy(desc(apiCacheAccess.paidAt))
    .limit(RECENT_LIMIT);
  return rows;
}
