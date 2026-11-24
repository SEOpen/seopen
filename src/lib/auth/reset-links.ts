import { and, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { verifications } from "@/db/schema";

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
