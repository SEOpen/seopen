import { describe, expect, it, vi } from "vitest";
import { href } from "./market";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dataforseo/places", () => ({ cityInMarket: vi.fn(async () => null) }));

const { researchCity } = await import("./city");

const market = { locationCode: 2840, languageCode: "en" };
const noCity = { locationCode: 2840, cityCode: null, cityName: null };
const hasCity = { locationCode: 2840, cityCode: 1014044, cityName: "Austin" };

describe("a pinned city on a Run address", () => {
  it("keeps city=0 in the address", () => {
    expect(href("/keywords", { q: "shoes", loc: 2840, city: 0, run: 1 })).toBe("/keywords?q=shoes&loc=2840&city=0&run=1");
  });

  it("stays on no city after switching to a project that has one", async () => {
    expect((await researchCity("0", market, noCity)).city).toBeNull();
    expect((await researchCity("0", market, hasCity)).city).toBeNull();
  });

  it("would take on the new project's city with the param left out, which is why it's pinned", async () => {
    expect((await researchCity(undefined, market, noCity)).city).toBeNull();
    expect((await researchCity(undefined, market, hasCity)).city).toEqual({ code: 1014044, name: "Austin" });
  });
});
