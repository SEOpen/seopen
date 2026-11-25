import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { OAuth2Client } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** Disconnecting one workspace's Google account, against seopen_test: another workspace using the same Google account keeps working. */

vi.mock("server-only", () => ({}));
process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test.apps.googleusercontent.example";
process.env.GOOGLE_CLIENT_SECRET = "test";

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { disconnectAccount, getAccount, saveAccount } = await import("./auth");

const revoke = vi.spyOn(OAuth2Client.prototype, "revokeToken").mockImplementation(async () => ({}) as never);

async function connected(googleSub: string) {
  const [ws] = await db.insert(s.workspaces).values({ name: `google-${randomUUID()}`, plan: "internal" }).returning();
  await saveAccount(ws.id, { email: "pat@example.com", googleSub, refreshToken: "token", scopes: [] });
  return ws.id;
}

describe.skipIf(!ready)("disconnectAccount", () => {
  beforeEach(() => revoke.mockClear());

  it("leaves Google's grant alone while another workspace uses the same Google account, and revokes it with the last one", async () => {
    const sub = randomUUID();
    const [first, second, other] = [await connected(sub), await connected(sub), await connected(randomUUID())];

    expect(await disconnectAccount(first)).toEqual({ ok: true });
    expect(revoke).not.toHaveBeenCalled();
    expect(await getAccount(first)).toBeNull();
    expect(await getAccount(second)).not.toBeNull();

    expect(await disconnectAccount(second)).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await getAccount(second)).toBeNull();
    expect(await getAccount(other)).not.toBeNull();

    await db.delete(s.googleAccounts).where(eq(s.googleAccounts.workspaceId, other));
  });
});
