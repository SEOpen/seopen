import { createCimdClientDiscovery, isCimdClientIdUrlCandidate, validateClientIdUrl } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { extendOAuthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { addressKey, CLIENT_IP_HEADER } from "@/lib/web/client-ip";

/**
 * Client ID metadata documents: an app names itself with an https URL, and the app reads that URL
 * to learn who is asking. `@better-auth/cimd` does the reading, checking and storing; this wraps
 * its lookup, because the lookup runs for callers with no account at all (authorize, token, revoke
 * and introspect all resolve the client first) and the plugin keeps one budget of reads for
 * everyone in the process. Left alone, requests naming made-up URLs used that budget up, and an app
 * a customer had connected could not refresh until it freed. Three rules here:
 *
 * 1. A URL that will never be read (not a public https address) is refused before anything is counted.
 * 2. A URL with no stored app behind it is counted against the caller's address, a few a minute.
 *    An app is stored the first time its document reads well, so this counts new apps only.
 * 3. An app that is stored keeps working from its stored row when its document can't be read again
 *    just now.
 *
 * The plugin id and the discovery id both stay "cimd": stored apps name the discovery they came from.
 */

/** New, never-seen client ID URLs one address may name in a minute. */
export const UNKNOWN_CLIENT_LIMIT = { max: 10, windowMs: 60_000 } as const;

/**
 * Document reads a minute across the process, above what rule 2 lets a crowd of addresses ask for
 * (the plugin's own default is 120). Reads for one origin stay at the plugin's 30 a minute.
 */
const FETCHES_PER_MINUTE = 600;

const unavailable = (description: string) => new APIError("TOO_MANY_REQUESTS", { error: "temporarily_unavailable", error_description: description });

/**
 * Whether the plugin refused a read for lack of budget, not for anything wrong with the document.
 * Read off the error's body: the plugin throws its own copy of the error class, so `instanceof` says
 * no. Its wait after a read that failed carries the same code and is not this: an app whose document
 * has gone must not be served from its row between tries.
 */
const outOfBudget = (error: unknown) => {
  const body = (error as { body?: { error?: unknown; error_description?: unknown } } | null)?.body;
  return body?.error === "temporarily_unavailable" && /limit exceeded/.test(String(body.error_description ?? ""));
};

/** Counts one new client ID URL for an address and refuses past the limit. Shared by every instance, in `rate_limits` (see src/modules/fixes/limit.ts). */
async function countUnknownClient(address: string, now = new Date()): Promise<void> {
  const { max, windowMs } = UNKNOWN_CLIENT_LIMIT;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const key = `seopen:new-client-url:${address}:${windowStart}`;
  const [row] = await db
    .insert(rateLimits)
    .values({ id: key, key, count: 1, lastRequest: now.getTime() })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1`, lastRequest: now.getTime() } })
    .returning({ count: rateLimits.count });
  if (row.count > max) throw unavailable("Too many new apps from this address. Try again in a minute.");
}

export function clientMetadata(): BetterAuthPlugin {
  const discovery = createCimdClientDiscovery({
    // Resolves the host once, refuses private addresses, pins the connection and never follows a redirect.
    fetchClientMetadataResource,
    metadataProfile: "mcp-2026-07-28",
    metadataFetchPolicy: { maximumFetchesPerMinute: FETCHES_PER_MINUTE },
  });
  const guarded: typeof discovery = {
    ...discovery,
    resolve: async (ctx, clientId, existing) => {
      if (!isCimdClientIdUrlCandidate(clientId)) return null;
      const urlError = validateClientIdUrl(clientId);
      if (urlError) throw new APIError("BAD_REQUEST", { error: "invalid_client", error_description: urlError });
      if (!existing) {
        // The address the proxy set (src/proxy.ts); a copy with no trusted proxy counts everyone together.
        const headers = ctx.headers ?? ctx.request?.headers;
        await countUnknownClient(addressKey(headers?.get(CLIENT_IP_HEADER)));
        return discovery.resolve(ctx, clientId, existing);
      }
      try {
        return await discovery.resolve(ctx, clientId, existing);
      } catch (error) {
        if (outOfBudget(error)) return existing;
        throw error;
      }
    },
  };
  return {
    id: "cimd",
    init(ctx) {
      extendOAuthProvider(ctx, { clientDiscovery: guarded });
    },
  };
}
