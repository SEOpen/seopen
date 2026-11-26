import { describe, expect, it } from "vitest";
import { testDb } from "@/db/test-db";

/** The app's fix buttons share one limit per workspace (`countFixAction`), counted in seopen_test. */

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { APP_FIX_LIMIT, countFixAction } = await import("./limit");

const workspace = async () => (await db.insert(s.workspaces).values({ name: `limit-${Date.now()}-${Math.random()}`, plan: "internal" }).returning())[0].id;

describe.skipIf(!ready)("countFixAction", () => {
  it("refuses past the limit, for that workspace and window only", async () => {
    const [a, b] = [await workspace(), await workspace()];
    const now = new Date(Math.floor(Date.now() / APP_FIX_LIMIT.windowMs) * APP_FIX_LIMIT.windowMs + 1_000);
    for (let i = 0; i < APP_FIX_LIMIT.max; i++) await countFixAction(a, now);
    await expect(countFixAction(a, now)).rejects.toThrow("Too many tries");
    await expect(countFixAction(b, now)).resolves.toBeUndefined();
    await expect(countFixAction(a, new Date(now.getTime() + APP_FIX_LIMIT.windowMs))).resolves.toBeUndefined();
  });
});
