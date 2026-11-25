import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";

/** How an account can sign in. Neither, for no-login mode's owner before a password is set. */
export async function signInMethods(userId: string): Promise<{ password: boolean; google: boolean }> {
  const rows = await db.select({ provider: accounts.providerId, password: accounts.password }).from(accounts).where(eq(accounts.userId, userId));
  return {
    password: rows.some((r) => r.provider === "credential" && r.password !== null),
    google: rows.some((r) => r.provider === "google"),
  };
}
