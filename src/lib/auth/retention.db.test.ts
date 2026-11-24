import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The daily purge of Better Auth's rows that hold a raw IP address, against seopen_test: sessions a
 * week past their expiry, and rate limit counters an hour past their last request. Better Auth only
 * deletes an expired session when its cookie comes back, and a counter only when its own key is used
 * again after its window, so rows nobody returns to stay forever without this. And the daily purge
 * of registered OAuth apps nobody consented to in 90 days, which anyone can add 30 a minute of.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const { oauthAccessTokens, oauthClients, oauthConnections, oauthConsents, oauthRefreshTokens, rateLimits, sessions, users, workspaces } = await import("@/db/schema");
const { RATE_LIMIT_KEEP_MS, SESSION_GRACE_DAYS, UNUSED_APP_KEEP_MS, purgeAuthRows, purgeUnusedOAuthClients } = await import("./retention");

const DAY = 86_400_000;

describe.skipIf(!ready)("purgeAuthRows", () => {
  it("deletes sessions a week past their expiry and keeps the rest", async () => {
    const now = new Date();
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `${userId}@example.com` });
    const session = (name: string, expiresAt: Date) => ({ id: `${userId}-${name}`, userId, token: `${userId}-${name}`, expiresAt, ipAddress: "203.0.113.9", userAgent: "Test" });
    await db.insert(sessions).values([
      session("long-gone", new Date(now.getTime() - (SESSION_GRACE_DAYS + 1) * DAY)),
      session("in-grace", new Date(now.getTime() - (SESSION_GRACE_DAYS - 1) * DAY)),
      session("live", new Date(now.getTime() + 30 * DAY)),
    ]);

    const purged = await purgeAuthRows(now);
    expect(purged.sessions).toBeGreaterThanOrEqual(1);
    const left = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
    expect(left.map((s) => s.id).sort()).toEqual([`${userId}-in-grace`, `${userId}-live`]);
    await db.delete(users).where(eq(users.id, userId));
  });

  it("deletes rate limit counters an hour past their last request and keeps the rest", async () => {
    const now = new Date();
    const id = randomUUID();
    const counter = (name: string, ago: number) => ({ id: `${id}-${name}`, key: `203.0.113.9|/sign-in/email|${id}-${name}`, count: 1, lastRequest: now.getTime() - ago });
    await db.insert(rateLimits).values([counter("old", RATE_LIMIT_KEEP_MS + 60_000), counter("recent", RATE_LIMIT_KEEP_MS - 60_000)]);

    const purged = await purgeAuthRows(now);
    expect(purged.rateLimits).toBeGreaterThanOrEqual(1);
    const left = await db.select({ id: rateLimits.id }).from(rateLimits).where(inArray(rateLimits.id, [`${id}-old`, `${id}-recent`]));
    expect(left).toEqual([{ id: `${id}-recent` }]);
    await db.delete(rateLimits).where(eq(rateLimits.id, `${id}-recent`));
  });

  it("keeps every counter inside the longest rate limit window", () => {
    // The longest window in src/lib/auth (sign-in, sign-up and the email routes) is 10 minutes.
    expect(RATE_LIMIT_KEEP_MS).toBeGreaterThan(10 * 60_000);
  });
});

describe.skipIf(!ready)("purgeUnusedOAuthClients", () => {
  const app = (tag: string, name: string, createdAt: Date | null) => ({ id: `${tag}-${name}`, clientId: `${tag}-${name}`, redirectUris: ["http://127.0.0.1:33418/callback"], createdAt });

  it("deletes apps over 90 days old with no consent, connection or tokens, and keeps every other app", async () => {
    const now = new Date();
    const tag = randomUUID();
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `${userId}@example.com` });
    const [ws] = await db.insert(workspaces).values({ name: `purge-${tag}`, plan: "internal" }).returning();
    const old = new Date(now.getTime() - UNUSED_APP_KEEP_MS - 60_000);
    await db.insert(oauthClients).values([
      app(tag, "unused", old),
      app(tag, "fresh", new Date(now.getTime() - UNUSED_APP_KEEP_MS + 60_000)),
      // Disconnected a day ago: the reconnect with its cached client ID must still find it.
      app(tag, "disconnected", new Date(now.getTime() - 2 * DAY)),
      app(tag, "undated", null),
      app(tag, "consented", old),
      app(tag, "connected", old),
      app(tag, "refresh-only", old),
      app(tag, "access-only", old),
    ]);
    await db.insert(oauthConsents).values({ id: `${tag}-consent`, clientId: `${tag}-consented`, userId, referenceId: String(ws.id), scopes: ["read"] });
    await db.insert(oauthConnections).values({ workspaceId: ws.id, userId, clientId: `${tag}-connected` });
    await db.insert(oauthRefreshTokens).values({ id: `${tag}-refresh`, token: `${tag}-refresh`, clientId: `${tag}-refresh-only`, userId, scopes: ["read"] });
    await db.insert(oauthAccessTokens).values({ id: `${tag}-access`, token: `${tag}-access`, clientId: `${tag}-access-only`, userId, scopes: ["read"] });

    expect(await purgeUnusedOAuthClients(now)).toBeGreaterThanOrEqual(1);
    const left = await db.select({ id: oauthClients.id }).from(oauthClients).where(like(oauthClients.id, `${tag}-%`));
    expect(left.map((c) => c.id).sort()).toEqual(["access-only", "connected", "consented", "disconnected", "fresh", "refresh-only", "undated"].map((n) => `${tag}-${n}`));
    // The kept apps' consent is untouched.
    expect(await db.select({ id: oauthConsents.id }).from(oauthConsents).where(eq(oauthConsents.clientId, `${tag}-consented`))).toEqual([{ id: `${tag}-consent` }]);

    await db.delete(oauthClients).where(like(oauthClients.id, `${tag}-%`));
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("never deletes a consent saved while it runs along with its app", async () => {
    const now = new Date();
    const tag = randomUUID();
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `${userId}@example.com` });
    await db.insert(oauthClients).values(app(tag, "racing", new Date(now.getTime() - UNUSED_APP_KEEP_MS - 60_000)));

    // Someone allows the app on another connection: the consent's foreign key check holds the app's row.
    const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      let commit!: () => void;
      const committed = new Promise<void>((r) => (commit = r));
      const consenting = other.begin(async (sql) => {
        await sql`insert into oauth_consents (id, client_id, user_id, scopes) values (${`${tag}-consent`}, ${`${tag}-racing`}, ${userId}, ${["read"]})`;
        await committed;
      });
      await new Promise((r) => setTimeout(r, 100));
      // The purge starts before the consent is committed, so its snapshot can't see it, and waits on the row.
      const purging = purgeUnusedOAuthClients(now).then(
        (n) => ({ ok: true as const, n }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      await new Promise((r) => setTimeout(r, 200));
      commit();
      await consenting;
      const outcome = await purging;
      if (!outcome.ok) expect(String((outcome.err as { cause?: unknown }).cause ?? outcome.err)).toMatch(/serializ/i);

      expect(await db.select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.id, `${tag}-racing`))).toEqual([{ id: `${tag}-racing` }]);
      expect(await db.select({ id: oauthConsents.id }).from(oauthConsents).where(eq(oauthConsents.clientId, `${tag}-racing`))).toEqual([{ id: `${tag}-consent` }]);
      // Run again, it sees the consent and keeps the app.
      await purgeUnusedOAuthClients(now);
      expect(await db.select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.id, `${tag}-racing`))).toHaveLength(1);
    } finally {
      await other.end({ timeout: 1 });
      await db.delete(oauthClients).where(eq(oauthClients.id, `${tag}-racing`));
      await db.delete(users).where(eq(users.id, userId));
    }
  });

  it("keeps an app far past the 10 minutes a consent request lasts", () => {
    expect(UNUSED_APP_KEEP_MS).toBeGreaterThanOrEqual(90 * DAY);
  });
});
