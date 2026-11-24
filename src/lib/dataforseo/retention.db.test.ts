import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The daily purge of cached DataForSEO responses, against seopen_test: responses past their expiry,
 * which no lookup reads as a hit, and the record of who paid for a response that is gone or expired,
 * go. Live responses and who paid for them stay. The purge runs on a clock in 2001, so it can't touch
 * rows other test files are using at the same time.
 */

const ready = await testDb();

const { db } = await import("@/db");
const { apiCache, apiCacheAccess, workspaces } = await import("@/db/schema");
const { PURGE_BATCH } = await import("@/lib/purge");
const { purgeExpiredCache } = await import("./retention");

const NOW = new Date("2001-01-01T00:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe.skipIf(!ready)("purgeExpiredCache", () => {
  it("deletes expired responses and access to them, in batches, and keeps live ones", async () => {
    const [ws] = await db.insert(workspaces).values({ name: `cache-purge-${randomUUID()}`, plan: "internal" }).returning();
    const id = randomUUID();
    const k = { expired: `w${ws.id}:${id}-expired`, live: `w${ws.id}:${id}-live`, gone: `w${ws.id}:${id}-gone`, sharedLive: `${id}-shared-live` };
    const row = (key: string, expiresAt: Date) => ({ key, endpoint: "test/purge", response: {}, createdAt: at(-DAY), expiresAt });
    // More than one batch of expired rows.
    const bulk = Array.from({ length: PURGE_BATCH + 5 }, (_, i) => `w${ws.id}:${id}-bulk-${i}`);
    await db.insert(apiCache).values([row(k.expired, at(-MINUTE)), row(k.live, at(7 * DAY)), row(k.sharedLive, at(MINUTE)), ...bulk.map((key) => row(key, at(-DAY)))]);
    await db.insert(apiCacheAccess).values([
      { key: k.expired, workspaceId: ws.id, paidAt: at(-DAY) },
      { key: k.live, workspaceId: ws.id, paidAt: at(-DAY) },
      { key: k.sharedLive, workspaceId: ws.id, paidAt: at(-DAY) },
      // No response left at all, as after a workspace delete or the free tools' purge.
      { key: k.gone, workspaceId: ws.id, paidAt: at(-DAY) },
      ...bulk.map((key) => ({ key, workspaceId: ws.id, paidAt: at(-2 * DAY) })),
    ]);

    const purged = await purgeExpiredCache(NOW);

    const cache = await db.select({ key: apiCache.key }).from(apiCache).where(like(apiCache.key, `%${id}%`));
    expect(cache.map((r) => r.key).sort()).toEqual([k.live, k.sharedLive].sort());
    const access = await db.select({ key: apiCacheAccess.key }).from(apiCacheAccess).where(eq(apiCacheAccess.workspaceId, ws.id));
    expect(access.map((r) => r.key).sort()).toEqual([k.live, k.sharedLive].sort());
    expect(purged.cache).toBeGreaterThanOrEqual(PURGE_BATCH + 6);
    expect(purged.access).toBeGreaterThanOrEqual(PURGE_BATCH + 7);

    await db.delete(apiCacheAccess).where(eq(apiCacheAccess.workspaceId, ws.id));
    await db.delete(apiCache).where(inArray(apiCache.key, [k.live, k.sharedLive]));
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
  });
});
