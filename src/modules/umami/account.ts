import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { umamiAccounts } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { UmamiNotConnectedError } from "./types";

export type UmamiAccount = typeof umamiAccounts.$inferSelect;
/** What anything outside this file may know about a connection: everything but the credential. */
export type UmamiConnectionInfo = Omit<UmamiAccount, "credentialEnc">;
export type UmamiAuthType = "api_key" | "login";

/**
 * Development switch: SEOPEN_UMAMI_FIXTURES=1 in .env.local serves generated data instead of
 * calling Umami, for working on the screens without an Umami account.
 */
export function fixtureMode(): boolean {
  return process.env.SEOPEN_UMAMI_FIXTURES === "1";
}

const INFO = {
  id: umamiAccounts.id,
  workspaceId: umamiAccounts.workspaceId,
  baseUrl: umamiAccounts.baseUrl,
  authType: umamiAccounts.authType,
  status: umamiAccounts.status,
  connectedAt: umamiAccounts.connectedAt,
  lastError: umamiAccounts.lastError,
};

/** The workspace's connection without the credential, for pages and Admin. */
export async function getUmamiConnectionInfo(workspaceId: number): Promise<UmamiConnectionInfo | null> {
  const [row] = await db.select(INFO).from(umamiAccounts).where(eq(umamiAccounts.workspaceId, workspaceId));
  return row ?? null;
}

/** Stores a checked credential as the workspace's connection, replacing its previous one. */
export async function saveUmamiAccount(workspaceId: number, c: { baseUrl: string | null; authType: UmamiAuthType; credential: string }) {
  const values = { workspaceId, baseUrl: c.baseUrl, authType: c.authType, credentialEnc: encrypt(c.credential), status: "active", connectedAt: new Date(), lastError: null };
  await db.insert(umamiAccounts).values(values).onConflictDoUpdate({ target: umamiAccounts.workspaceId, set: values });
}

/** Forgets the workspace's credential. SEOpen can't revoke it at Umami, so it stays valid there until the customer deletes it. */
export async function disconnectUmamiAccount(workspaceId: number) {
  await db.delete(umamiAccounts).where(eq(umamiAccounts.workspaceId, workspaceId));
}

/** The workspace's credential, for the API client alone. One Umami refused isn't tried again until it's replaced. */
export async function umamiCredential(workspaceId: number): Promise<{ credential: string; account: UmamiConnectionInfo }> {
  const [row] = await db.select().from(umamiAccounts).where(eq(umamiAccounts.workspaceId, workspaceId));
  if (!row) throw new UmamiNotConnectedError("not_connected");
  if (row.status === "reauth_required") throw new UmamiNotConnectedError("reauth_required");
  const { credentialEnc, ...account } = row;
  return { credential: decrypt(credentialEnc), account };
}

/** Called when Umami rejects a credential we believed was live (a deleted key, or an expired login). */
export async function rejectUmamiCredential(account: Pick<UmamiAccount, "id" | "workspaceId">) {
  await db
    .update(umamiAccounts)
    .set({ status: "reauth_required", lastError: "Umami rejected the saved credential (deleted, replaced or expired)" })
    .where(and(eq(umamiAccounts.id, account.id), eq(umamiAccounts.workspaceId, account.workspaceId)));
}
