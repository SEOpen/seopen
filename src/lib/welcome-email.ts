import { and, eq, isNull, sql } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { users, workspaceMembers, workspaces } from "@/db/schema";
import { sendEmail, welcomeMessage } from "@/lib/email";
import { appOrigin } from "@/lib/hosts";

/**
 * The welcome email, sent once, the first time a customer signs in.
 * Every way in (a password set from an invite, Google, a verified sign-up if it ever opens) creates
 * a session, and a session means the account works, so the hook is Better Auth's session create.
 *
 * The claim is one conditional UPDATE: of any number of sign-ins only the first matches. It wants a
 * verified email and a workspace, and no membership of an internal one, so the owner gets nothing.
 */
export async function sendWelcomeEmail(userId: string): Promise<void> {
  try {
    const [claimed] = await db
      .update(users)
      .set({ welcomeEmailAt: new Date() })
      .where(
        and(
          eq(users.id, userId),
          isNull(users.welcomeEmailAt),
          eq(users.emailVerified, true),
          sql`exists (select 1 from ${workspaceMembers} where ${workspaceMembers.userId} = ${users.id})`,
          sql`not exists (
            select 1 from ${workspaceMembers} inner join ${workspaces} on ${workspaces.id} = ${workspaceMembers.workspaceId}
            where ${workspaceMembers.userId} = ${users.id} and ${workspaces.plan} = 'internal')`,
        ),
      )
      .returning({ email: users.email });
    if (!claimed) return;
    try {
      // Keyed by user, so a retry after a send that timed out can't welcome them twice.
      await sendEmail({ to: claimed.email, ...welcomeMessage(`${appOrigin()}/projects/new`) }, { idempotencyKey: `welcome-email/${userId}` });
    } catch (err) {
      // Not sent, so the next sign-in tries again.
      console.error("[welcome] email not sent:", err instanceof Error ? err.message : err);
      await db.update(users).set({ welcomeEmailAt: null }).where(eq(users.id, userId));
    }
  } catch (err) {
    console.error("[welcome] failed:", err instanceof Error ? err.message : err);
  }
}

/** After the response, like analytics, so email never slows or breaks a sign-in. Straight away outside a request. */
export function queueWelcomeEmail(userId: string): void {
  const send = () => sendWelcomeEmail(userId);
  try {
    after(send);
  } catch {
    void send();
  }
}
