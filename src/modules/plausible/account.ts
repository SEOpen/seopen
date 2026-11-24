import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { plausibleAccounts } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { PlausibleNotConnectedError } from "./types";

export type PlausibleAccount = typeof plausibleAccounts.$inferSelect;
/** What anything outside this file may know about a connection: everything but the key. */
export type PlausibleConnectionInfo = Omit<PlausibleAccount, "apiKeyEnc">;

/**
 * Development switch: SEOPEN_PLAUSIBLE_FIXTURES=1 in .env.local serves generated data instead of
 * calling Plausible, for working on the screens without a Plausible account.
 */
export function fixtureMode(): boolean {
  return process.env.SEOPEN_PLAUSIBLE_FIXTURES === "1";
}

/** The workspace's connection without the key, for pages and Admin. */
export async function getPlausibleConnectionInfo(workspaceId: number): Promise<PlausibleConnectionInfo | null> {
  const [row] = await db
    .select({ id: plausibleAccounts.id, workspaceId: plausibleAccounts.workspaceId, status: plausibleAccounts.status, connectedAt: plausibleAccounts.connectedAt, lastError: plausibleAccounts.lastError })
    .from(plausibleAccounts)
    .where(eq(plausibleAccounts.workspaceId, workspaceId));
  return row ?? null;
}

/** Stores a checked key as the workspace's connection, replacing its previous one. */
export async function savePlausibleAccount(workspaceId: number, apiKey: string) {
  const values = { workspaceId, apiKeyEnc: encrypt(apiKey), status: "active", connectedAt: new Date(), lastError: null };
  await db.insert(plausibleAccounts).values(values).onConflictDoUpdate({ target: plausibleAccounts.workspaceId, set: values });
}

/** Forgets the workspace's key. Plausible has no API to revoke one, so it stays valid there until the customer deletes it. */
export async function disconnectPlausibleAccount(workspaceId: number) {
  await db.delete(plausibleAccounts).where(eq(plausibleAccounts.workspaceId, workspaceId));
}

/** The workspace's key, for the API client alone. A key Plausible refused isn't tried again until it's replaced. */
export async function plausibleKey(workspaceId: number): Promise<{ key: string; account: PlausibleConnectionInfo }> {
  const [row] = await db.select().from(plausibleAccounts).where(eq(plausibleAccounts.workspaceId, workspaceId));
  if (!row) throw new PlausibleNotConnectedError("not_connected");
  if (row.status === "reauth_required") throw new PlausibleNotConnectedError("reauth_required");
  const { apiKeyEnc, ...account } = row;
  return { key: decrypt(apiKeyEnc), account };
}

/** Called when Plausible rejects a key we believed was live (deleted in its settings). */
export async function rejectPlausibleKey(account: Pick<PlausibleAccount, "id" | "workspaceId">) {
  await db
    .update(plausibleAccounts)
    .set({ status: "reauth_required", lastError: "Plausible rejected the API key (deleted or replaced)" })
    .where(and(eq(plausibleAccounts.id, account.id), eq(plausibleAccounts.workspaceId, account.workspaceId)));
}
