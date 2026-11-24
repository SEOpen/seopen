import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** The platform cap fails closed: without a readable setting it caps at the default instead of letting every call through. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const { settings } = await import("@/db/schema");
const { DEFAULT_PLATFORM_CAP_USD, PLATFORM_CAP_SETTING_KEY, platformCapUsd } = await import("./spend");

describe.skipIf(!ready)("the platform cap", () => {
  it("reads the setting, and falls back to the default when it's missing or invalid", async () => {
    const [saved] = await db.select().from(settings).where(eq(settings.key, PLATFORM_CAP_SETTING_KEY));
    try {
      await db.insert(settings).values({ key: PLATFORM_CAP_SETTING_KEY, value: 250 }).onConflictDoUpdate({ target: settings.key, set: { value: 250 } });
      expect(await platformCapUsd()).toBe(250);
      for (const value of [0, -5, "not a number"]) {
        await db.update(settings).set({ value }).where(eq(settings.key, PLATFORM_CAP_SETTING_KEY));
        expect(await platformCapUsd()).toBe(DEFAULT_PLATFORM_CAP_USD);
      }
      await db.delete(settings).where(eq(settings.key, PLATFORM_CAP_SETTING_KEY));
      expect(await platformCapUsd()).toBe(DEFAULT_PLATFORM_CAP_USD);
    } finally {
      if (saved) await db.insert(settings).values(saved).onConflictDoUpdate({ target: settings.key, set: { value: saved.value } });
    }
  });
});
