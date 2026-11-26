import { and, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { verifications } from "@/db/schema";

/** The reset page (`src/app/(auth)/reset-password`), the one place a set-password link opens. */
export const RESET_PASSWORD_PATH = "/reset-password";

/**
 * The link mailed for a password reset or an invite: the reset page itself, with the token in the
 * query. Better Auth's own link puts the token in the path, /api/auth/reset-password/<token>, and a
 * path can't be masked in what a firewall or proxy keeps of a request, as a query value can
 * (WAF's data protection takes headers, cookies, query values and the body only). That route still
 * works, for links mailed before this one; nothing sends people there now.
 */
export function resetPageLink(origin: string, token: string, invite = false): string {
  const link = new URL(RESET_PASSWORD_PATH, origin);
  link.searchParams.set("token", token);
  if (invite) link.searchParams.set("invite", "1");
  return link.toString();
}

/**
 * Whether a set-password token can still be used: its row is there and hasn't expired. The reset
 * page checks before it shows the form, as Better Auth's link route did before sending people on.
 */
export async function resetTokenUsable(token: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ expiresAt: verifications.expiresAt })
    .from(verifications)
    .where(eq(verifications.identifier, `reset-password:${token}`))
    .limit(1);
  return !!row && row.expiresAt > now;
}

/**
 * Deletes every set-password link the user still has: Better Auth's `reset-password:<token>` rows,
 * whose value is the user id. An invite resent, or a password just chosen, leaves no older link
 * that could set it again. Returns how many went.
 */
export async function revokeResetLinks(userId: string): Promise<number> {
  const rows = await db
    .delete(verifications)
    .where(and(like(verifications.identifier, "reset-password:%"), eq(verifications.value, userId)))
    .returning({ id: verifications.id });
  return rows.length;
}
