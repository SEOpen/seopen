import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** Looking towns up by name against seopen_test: the spellings a site uses find the list's spelling, and nothing outside the country. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const { dfsPlaces } = await import("@/db/schema/core");
const { placesNamed } = await import("./places");

const CODES = [900201, 900202, 900203, 900204];

describe.skipIf(!ready)("placesNamed", () => {
  afterAll(async () => {
    await db.delete(dfsPlaces).where(inArray(dfsPlaces.code, CODES));
  });

  it("matches a town however it's spelled, and only in the project's country", async () => {
    await db.insert(dfsPlaces).values([
      { code: 900201, name: "Saint Qzhedwig, Texas", countryIso: "us" },
      { code: 900202, name: "Ft. Qzworth, Texas", countryIso: "us" },
      { code: 900203, name: "Qzlondon, Ohio", countryIso: "us" },
      { code: 900204, name: "Qzlondon", countryIso: "gb" },
    ]);
    const codes = async (names: string[]) => (await placesNamed(2840, names)).map((p) => p.code);
    expect(await codes(["St Qzhedwig"])).toEqual([900201]);
    expect(await codes(["St. Qzhedwig"])).toEqual([900201]);
    expect(await codes(["Fort Qzworth"])).toEqual([900202]);
    expect(await codes(["QZLONDON"])).toEqual([900203]);
    expect(await codes(["Qznowhere"])).toEqual([]);
    expect(await placesNamed(2840, [])).toEqual([]);
  });
});
