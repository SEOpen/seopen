import type { BetterAuthPlugin, User, UserProvisioningSource } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { users, workspaceMembers } from "@/db/schema";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";
import { LOCAL_OWNER_EMAIL, noLoginRefusal } from "./no-login";
import { safeCallback } from "./redirect";

/** The path, under /api/auth, that no-login mode signs in at (src/lib/auth/no-login.ts). */
export const NO_LOGIN_PATH = "/local-sign-in";

/** The parts of Better Auth's internal adapter this uses. */
interface InternalAdapter {
  findUserById(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<{ user: User } | null>;
  createUser(user: { email: string; name: string; emailVerified: boolean }, source: UserProvisioningSource): Promise<User>;
}

/** The owner workspace's first owner, made with no password when there is none yet. */
async function localOwner(adapter: InternalAdapter) {
  const find = async () => {
    const [row] = await db
      .select({ id: users.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, OWNER_WORKSPACE_ID), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(users.createdAt))
      .limit(1);
    return row ? adapter.findUserById(row.id) : null;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    const user = (await adapter.findUserByEmail(LOCAL_OWNER_EMAIL))?.user ?? (await adapter.createUser({ email: LOCAL_OWNER_EMAIL, name: "", emailVerified: true }, { method: "admin" }));
    await db.insert(workspaceMembers).values({ workspaceId: OWNER_WORKSPACE_ID, userId: user.id, role: "owner" }).onConflictDoNothing();
  } catch (err) {
    // Two first requests at once: the other one made the account.
    console.warn("[no-login] making the local owner:", err instanceof Error ? err.message : err);
  }
  return find();
}

/**
 * GET /api/auth/local-sign-in?next=/path: with no-login mode on for this request, makes a session for
 * the owner and goes on to `next`. src/proxy.ts sends signed-out page requests here instead of to
 * /sign-in. With the mode off it answers 403 with the reason, and nothing changes.
 */
export function noLoginPlugin(): BetterAuthPlugin {
  return {
    id: "seopen-no-login",
    endpoints: {
      localSignIn: createAuthEndpoint(NO_LOGIN_PATH, { method: "GET" }, async (ctx) => {
        const refusal = noLoginRefusal(ctx.request?.headers ?? new Headers(ctx.headers ?? {}));
        if (refusal) throw new APIError("FORBIDDEN", { message: `No-login mode is off because ${refusal}. Sign in at /sign-in, or see docs/self-hosting.md.` });
        const user = await localOwner(ctx.context.internalAdapter);
        if (!user) throw new APIError("INTERNAL_SERVER_ERROR", { message: "No-login mode couldn't find or make the owner's account." });
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        const next = typeof ctx.query?.next === "string" ? ctx.query.next : undefined;
        throw ctx.redirect(safeCallback(next));
      }),
    },
  };
}
