import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiCacheClaims } from "@/db/schema";

/**
 * One fetch per cache key at a time. Before a call fetches a cacheable lookup from
 * DataForSEO it claims the key with a row in api_cache_claims. Another call with the same key (a
 * double click, parallel loads of a `run=1` page, parallel MCP lookups, the web app and the worker
 * at once) finds the claim, waits, and reads the answer from the cache instead of paying for it
 * again. Session advisory locks can't do this: the web app reaches Postgres through a transaction
 * pooler, so a session lock would outlive the call on someone else's connection. A claim is an
 * ordinary row, and every time it's compared with is the database's clock, so the web app and the
 * worker agree on when it ends.
 *
 * A claim is a lease. Its call renews it before every retry and deletes it when it ends, whether
 * the fetch worked or not. A call whose process died (a frozen or killed serverless function, a worker
 * crash) stops renewing, so its claim lapses one lease later and the next call takes it over.
 */

/**
 * How long one request to DataForSEO may take before the client gives up on it. Live endpoints
 * answer 50401 themselves at 120 seconds, but a Live Google SERP sent with `resolve_goto_urls`
 * follows Google's redirect links first and can run up to 260 seconds (DataForSEO, Nov 16 2026).
 * Giving up before then would pay for an answer nobody reads, so this sits just past it and only
 * ends a connection that has stopped answering. Such calls send `retries: 0`: a retry wouldn't
 * fit in a 300-second request limit.
 */
export const FETCH_TIMEOUT_MS = 270_000;

/**
 * How long a claim lasts without renewal: one request at its longest, plus the backoff before a
 * retry (8 seconds at most with the default retries) and saving the answer.
 */
export const CLAIM_LEASE_MS = FETCH_TIMEOUT_MS + 20_000;

/**
 * How long a call waits for another call's claim: one lease. A claim that lapses in that time is
 * taken over. One that's still live was renewed for a retry, and the wait ends with an error
 * rather than a second fetch: two fetches at once is the double payment this file prevents.
 */
export const CLAIM_WAIT_MS = CLAIM_LEASE_MS;

const POLL_FIRST_MS = 200;
const POLL_MAX_MS = 1000;

const lease = sql`now() + make_interval(secs => ${CLAIM_LEASE_MS / 1000})`;

/** Claims a key for this call: its token, or null while another call's claim on it is live. A lapsed claim is taken over. */
export async function claimKey(key: string): Promise<string | null> {
  const token = randomUUID();
  const [row] = await db
    .insert(apiCacheClaims)
    .values({ key, token, expiresAt: lease })
    .onConflictDoUpdate({
      target: apiCacheClaims.key,
      set: { token, expiresAt: lease, createdAt: sql`now()` },
      setWhere: sql`${apiCacheClaims.expiresAt} <= now()`,
    })
    .returning({ token: apiCacheClaims.token });
  return row?.token ?? null;
}

/** Extends this call's claim by a lease, before a retry. Does nothing once the claim is someone else's. */
export async function renewClaim(key: string, token: string): Promise<void> {
  await db
    .update(apiCacheClaims)
    .set({ expiresAt: lease })
    .where(and(eq(apiCacheClaims.key, key), eq(apiCacheClaims.token, token)));
}

/** Ends this call's claim, so a waiting call reads the answer or, when there's none, fetches it. */
export async function releaseClaim(key: string, token: string): Promise<void> {
  await db.delete(apiCacheClaims).where(and(eq(apiCacheClaims.key, key), eq(apiCacheClaims.token, token)));
}

/**
 * Waits while another call's claim on the key is live. "ended" when its claim was deleted or has
 * lapsed, so the cache may hold its answer or the key can be claimed. "busy" when the claim is
 * still live at `deadline` (a Date.now() time).
 */
export async function waitForClaim(key: string, deadline: number): Promise<"ended" | "busy"> {
  for (let pause = POLL_FIRST_MS; ; pause = Math.min(pause * 1.5, POLL_MAX_MS)) {
    const [row] = await db
      .select({ live: sql<boolean>`${apiCacheClaims.expiresAt} > now()` })
      .from(apiCacheClaims)
      .where(eq(apiCacheClaims.key, key));
    if (!row?.live) return "ended";
    if (Date.now() >= deadline) return "busy";
    await new Promise((r) => setTimeout(r, Math.min(pause, Math.max(deadline - Date.now(), 0))));
  }
}

/**
 * Deletes claims that lapsed, which only a call that died leaves behind (the daily billing.alerts
 * job). A lapsed claim blocks nothing, since the next call takes it over; this only keeps the table small.
 */
export async function purgeExpiredClaims(): Promise<number> {
  const rows = await db.delete(apiCacheClaims).where(sql`${apiCacheClaims.expiresAt} <= now()`).returning({ key: apiCacheClaims.key });
  return rows.length;
}
