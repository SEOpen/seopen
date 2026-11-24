import { describe, expect, it, vi } from "vitest";
import { firstVisitFromParams, firstVisitOnCreate, readFirstVisit } from "./first-visit";

/** Checking a first visit the browser sent: cut to fit, never an error, never our own host. */
describe("readFirstVisit", () => {
  it("keeps good values", () => {
    expect(readFirstVisit({ source: " newsletter ", referrerHost: "News.Example.com", landingPath: "/features/rank-tracking" })).toEqual({
      source: "newsletter",
      referrerHost: "news.example.com",
      landingPath: "/features/rank-tracking",
    });
  });

  it("cuts long values and drops junk", () => {
    expect(readFirstVisit({ source: "x".repeat(300), referrerHost: `${"a".repeat(300)}.com`, landingPath: `/${"b".repeat(300)}` })).toEqual({
      source: "x".repeat(100),
      referrerHost: "a".repeat(253),
      landingPath: `/${"b".repeat(199)}`,
    });
    expect(readFirstVisit({ source: "", referrerHost: "https://news.example.com/x", landingPath: "pricing" })).toEqual({ source: null, referrerHost: null, landingPath: null });
    expect(readFirstVisit({ source: 1, referrerHost: {}, landingPath: "/a?b=c" })).toEqual({ source: null, referrerHost: null, landingPath: null });
    for (const raw of [null, undefined, "text", 7, []]) expect(readFirstVisit(raw)).toEqual({ source: null, referrerHost: null, landingPath: null });
  });

  it("never takes our own hosts as the referrer", () => {
    vi.stubEnv("SEOPEN_SITE_HOST", "seopen.example");
    try {
      for (const host of ["seopen.example", "app.seopen.example", "www.seopen.example"]) expect(readFirstVisit({ referrerHost: host }).referrerHost).toBeNull();
      expect(readFirstVisit({ referrerHost: "notseopen.example" }).referrerHost).toBe("notseopen.example");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads /sign-up's query, taking only single values", () => {
    expect(firstVisitFromParams({ src: "reddit", ref_host: "www.reddit.com", landing: "/blog/x", error: "x" })).toEqual({ source: "reddit", referrerHost: "www.reddit.com", landingPath: "/blog/x" });
    expect(firstVisitFromParams({ src: ["a", "b"] })).toEqual({ source: null, referrerHost: null, landingPath: null });
  });
});

describe("firstVisitOnCreate", () => {
  const visit = { source: "s", referrerHost: "r.example", landingPath: "/" };
  const columns = { firstSource: "s", firstReferrerHost: "r.example", firstLandingPath: "/" };

  it("reads the email sign-up's body and an ID token's additionalData, with sign-up open", async () => {
    vi.stubEnv("SEOPEN_SIGNUP_OPEN", "1");
    await expect(firstVisitOnCreate("/sign-up/email", { firstVisit: visit })).resolves.toEqual(columns);
    await expect(firstVisitOnCreate("/sign-in/social", { additionalData: { firstVisit: visit } })).resolves.toEqual(columns);
    // An invite or admin account has no endpoint, and other endpoints make no self sign-up.
    await expect(firstVisitOnCreate(undefined, { firstVisit: visit })).resolves.toEqual({});
    await expect(firstVisitOnCreate("/update-user", { firstVisit: visit })).resolves.toEqual({});
    // Outside Better Auth's request scope a callback has no state, so no visit.
    await expect(firstVisitOnCreate("/callback/:id", {})).resolves.toEqual({ firstSource: null, firstReferrerHost: null, firstLandingPath: null });
    vi.unstubAllEnvs();
  });

  it("does nothing with sign-up closed", async () => {
    vi.stubEnv("SEOPEN_SIGNUP_OPEN", "");
    await expect(firstVisitOnCreate("/sign-up/email", { firstVisit: visit })).resolves.toEqual({});
    vi.unstubAllEnvs();
  });
});
