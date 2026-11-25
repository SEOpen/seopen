import { sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { OpError } from "@/lib/ops";

/**
 * How often the app's Check now, Mark applied and Log a change can run in one workspace. Each can
 * read live pages, so a button pressed again and again can't keep fetching a site. MCP calls count
 * against their key's `changes` limit instead (src/lib/mcp/limits.ts).
 */
export const APP_FIX_LIMIT = { max: 30, windowMs: 10 * 60_000 } as const;

/**
 * Counts one use and refuses past the limit. The counter lives in Better Auth's `rate_limits` table
 * under a key of our own that names the window, so every instance shares it, and the daily purge
 * clears it (src/lib/auth/retention.ts). That purge keeps a counter an hour past its last use, so
 * the window stays under an hour.
 */
export async function countFixAction(workspaceId: number, now = new Date()): Promise<void> {
  const { max, windowMs } = APP_FIX_LIMIT;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const key = `seopen:fix-actions:${workspaceId}:${windowStart}`;
  const [row] = await db
    .insert(rateLimits)
    .values({ id: key, key, count: 1, lastRequest: now.getTime() })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1`, lastRequest: now.getTime() } })
    .returning({ count: rateLimits.count });
  if (row.count > max) throw new OpError("Too many tries. Wait a few minutes and try again.");
}
