import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sensitiveSessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { revokeAgentAccess } from "./revoke-agents";

/** The path, under /api/auth, that Settings' "Sign out everywhere else" posts to. */
export const SIGN_OUT_ELSEWHERE_PATH = "/sign-out-elsewhere";

/**
 * POST /api/auth/sign-out-elsewhere: ends every other session of the account and, with `agents`, cuts
 * off its API keys and connected apps (./revoke-agents.ts). Better Auth's /revoke-other-sessions isn't
 * enough: it leaves this browser's token as it was, so a copy of this browser's cookie would stay in.
 * Here this browser gets a new token too. It keeps its session row, and with it when the session began,
 * so nobody can use this to make an old session count as a fresh sign-in.
 *
 * The new token comes first, so nothing can be made with a copied cookie once the rest has gone.
 */
export function signOutElsewherePlugin(): BetterAuthPlugin {
  return {
    id: "seopen-sign-out-elsewhere",
    endpoints: {
      signOutElsewhere: createAuthEndpoint(
        SIGN_OUT_ELSEWHERE_PATH,
        { method: "POST", body: z.object({ agents: z.boolean() }), use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          const adapter = ctx.context.internalAdapter;
          const kept = await adapter.updateSession(session.token, { token: generateRandomString(32), updatedAt: new Date() });
          // Ended by another browser since the check above.
          if (!kept) throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
          await setSessionCookie(ctx, { session: kept, user });
          const others = await db.select({ token: sessions.token }).from(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, session.id)));
          if (others.length) await adapter.deleteSessions(others.map((s) => s.token));
          if (ctx.body.agents) await revokeAgentAccess(user.id);
          return ctx.json({ status: true });
        },
      ),
    },
  };
}
