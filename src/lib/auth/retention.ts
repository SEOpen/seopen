import { and, eq, inArray, lt, notExists } from "drizzle-orm";
import { db } from "@/db";
import { oauthAccessTokens, oauthClients, oauthConnections, oauthConsents, oauthRefreshTokens, rateLimits, sessions } from "@/db/schema";
import { deleteInBatches } from "@/lib/purge";

/**
 * How long Better Auth's rows that hold a raw IP address are kept.
 * Every session row stores the IP address and user agent it signed in from, and every rate limit
 * counter is keyed by IP address and path. Better Auth deletes an expired session only when its
 * cookie comes back to `getSession`, and a counter only when the same key is used again after its
 * window, so a browser that never returns left both behind for good. The daily `billing.alerts`
 * job deletes them here. Registered OAuth apps nobody consented to go too, in `mcp.prune`. Runs in
 * the worker, so nothing here may import `server-only`.
 */

/**
 * Days a session is kept past its expiry. An expired session can't sign anyone in, so this is only
 * a margin: Admin's "last seen" reads `sessions.updated_at`, and a session lasts 30 days from its
 * last refresh (src/lib/auth). With the job daily, a session row goes within 38 days of its last use.
 */
export const SESSION_GRACE_DAYS = 7;

/**
 * A counter an hour past its last request: six times the longest window (10 minutes, sign-in and the
 * email routes), so no live count is reset. With the job daily, one goes within about 25 hours.
 */
export const RATE_LIMIT_KEEP_MS = 60 * 60_000;

export async function purgeAuthRows(now = new Date()): Promise<{ sessions: number; rateLimits: number }> {
  const gone = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now.getTime() - SESSION_GRACE_DAYS * 86_400_000)))
    .returning({ id: sessions.id });
  const counters = await db
    .delete(rateLimits)
    .where(lt(rateLimits.lastRequest, now.getTime() - RATE_LIMIT_KEEP_MS))
    .returning({ id: rateLimits.id });
  return { sessions: gone.length, rateLimits: counters.length };
}

/**
 * How old a registered app with no consent has to be before it goes: 90 days from registering.
 *
 * Nothing lasting says an app was ever connected: Disconnect deletes its consent, its refresh
 * tokens and its `oauth_connections` row, and its access tokens are JWTs that aren't stored. An app
 * such as Claude.ai keeps the client ID it registered and uses it again to reconnect, so a short
 * window would delete a disconnected app and its reconnect would fail with an unknown client.
 * Marking an app as once connected would need a new column, so the window is long instead: an app
 * someone disconnected in its first 90 days, and reconnects after that, still has to register again.
 * It is far past the 10 minutes a consent request lasts, so nobody is on /connect for an app that goes.
 */
export const UNUSED_APP_KEEP_MS = 90 * 24 * 60 * 60_000;

/**
 * Deletes apps registered more than 90 days ago with no consent, no connection and no tokens (the
 * daily `mcp.prune` job). Anyone may register an app (src/lib/auth/oauth.ts), 30 a minute from one
 * address, and registering alone grants nothing, so without this a script could add rows that stay
 * forever. An app found from its client ID metadata document is fetched again on its next request.
 * A row with no `created_at` stays, since its age can't be told.
 *
 * The checks sit in the DELETE's own WHERE, one statement per batch, and it runs in a REPEATABLE
 * READ transaction. A consent saved while the purge runs then either is seen and keeps its app, or
 * makes the delete fail with a serialization error (Postgres checks the cascade against rows its
 * snapshot can't see), and the job tries again: never is the consent deleted along with its app.
 */
export async function purgeUnusedOAuthClients(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - UNUSED_APP_KEEP_MS);
  // Correlated on `oauth_clients`, which is the DELETE's own row here and the batch's row below.
  const unused = and(
    lt(oauthClients.createdAt, cutoff),
    notExists(db.select({ id: oauthConsents.id }).from(oauthConsents).where(eq(oauthConsents.clientId, oauthClients.clientId))),
    notExists(db.select({ id: oauthConnections.id }).from(oauthConnections).where(eq(oauthConnections.clientId, oauthClients.clientId))),
    notExists(db.select({ id: oauthRefreshTokens.id }).from(oauthRefreshTokens).where(eq(oauthRefreshTokens.clientId, oauthClients.clientId))),
    notExists(db.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, oauthClients.clientId))),
  );
  return deleteInBatches((limit) =>
    db.transaction(
      async (tx) => {
        const batch = tx.select({ id: oauthClients.id }).from(oauthClients).where(unused).limit(limit);
        const rows = await tx
          .delete(oauthClients)
          .where(and(unused, inArray(oauthClients.id, batch)))
          .returning({ id: oauthClients.id });
        return rows.length;
      },
      { isolationLevel: "repeatable read" },
    ),
  );
}
