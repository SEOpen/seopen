import { describe, expect, it } from "vitest";
import { adsAccepts, cityPattern, listingCity, matchListing, placeName } from "./place-names";

describe("placeName", () => {
  it("drops the country", () => {
    expect(placeName("Salem,New Hampshire,United States")).toBe("Salem, New Hampshire");
    expect(placeName("Abashiri,Hokkaido,Japan")).toBe("Abashiri, Hokkaido");
  });
  it("drops repeated parts", () => {
    expect(placeName("Berlin,Berlin,Germany")).toBe("Berlin");
    expect(placeName("Auckland,Auckland,Auckland,New Zealand")).toBe("Auckland");
  });
});

describe("cityPattern", () => {
  it("reads a US state abbreviation", () => {
    expect(cityPattern("Salem NH", "us")).toBe("salem, new hampshire%");
    expect(cityPattern("salem, nh", "us")).toBe("salem, new hampshire%");
    expect(cityPattern("north salem nh", "us")).toBe("north salem, new hampshire%");
  });
  it("leaves everything else as typed, and doesn't read abbreviations outside the US", () => {
    expect(cityPattern("salem new", "us")).toBe("salem%new%");
    expect(cityPattern("Bath NH", "gb")).toBe("bath%nh%");
    expect(cityPattern("Sale", "us")).toBe("sale%");
  });
  it("takes wildcards out and refuses a too short query", () => {
    expect(cityPattern("c", "us")).toBeNull();
    expect(cityPattern("%%", "us")).toBeNull();
    expect(cityPattern("ch%ar_", "us")).toBe("char%");
  });
});

describe("listingCity", () => {
  it("reads what was typed", () => {
    expect(listingCity("Salem, NH", null, "us")).toEqual({ city: "Salem", region: "New Hampshire" });
    expect(listingCity("Bath, England", null, "gb")).toEqual({ city: "Bath", region: "England" });
  });
  it("finds a missing state in the address", () => {
    expect(listingCity("Salem", "1 Main St, Salem, NH 03079", "us")).toEqual({ city: "Salem", region: "New Hampshire" });
  });
  it("says so when it can't tell", () => {
    expect(listingCity("Salem", null, "us")).toEqual({ city: "Salem", region: null });
    expect(listingCity("  ", null, "us")).toBeNull();
  });
});

describe("matchListing", () => {
  const places = [
    { code: 1, name: "Salem, Illinois" },
    { code: 2, name: "Salem, New Hampshire" },
    { code: 3, name: "North Salem, New Hampshire" },
  ];
  it("keeps the region when it's known", () => {
    expect(matchListing(places, { city: "Salem", region: "New Hampshire" }).map((p) => p.code)).toEqual([2]);
  });
  it("offers every city of that name when it isn't", () => {
    expect(matchListing(places, { city: "salem", region: null }).map((p) => p.code)).toEqual([1, 2]);
  });
  it("offers nothing for a region that doesn't fit", () => {
    expect(matchListing(places, { city: "Salem", region: "Ohio" })).toEqual([]);
  });
});

describe("adsAccepts", () => {
  it("refuses what Google Ads refuses", () => {
    expect(adsAccepts("web design salem")).toBe(true);
    expect(adsAccepts("what's the best seo?")).toBe(false);
    expect(adsAccepts("x".repeat(81))).toBe(false);
    expect(adsAccepts("one two three four five six seven eight nine ten eleven")).toBe(false);
  });
});
