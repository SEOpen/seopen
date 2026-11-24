import { beforeEach, describe, expect, it, vi } from "vitest";

/** The site's in-memory first visit. Each test gets a fresh module, as a new tab would. */
let capture: typeof import("./first-visit-capture");
beforeEach(async () => {
  vi.resetModules();
  capture = await import("./first-visit-capture");
});

const OWN = ["getseopen.com", "app.getseopen.com"];
const SIGN_UP = "https://app.getseopen.com/sign-up";

describe("readVisit", () => {
  it("takes utm_source, then ref, the referring host and the landing path without its query", () => {
    expect(capture.readVisit("https://getseopen.com/pricing?utm_source=newsletter&ref=x", "https://news.example.com/post/1?a=b", OWN)).toEqual({
      source: "newsletter",
      referrerHost: "news.example.com",
      landingPath: "/pricing",
    });
    expect(capture.readVisit("https://getseopen.com/?ref=producthunt", "", OWN)).toEqual({ source: "producthunt", referrerHost: null, landingPath: "/" });
    expect(capture.readVisit("https://getseopen.com/tools?utm_source=", "", OWN).source).toBeNull();
  });

  it("counts only other sites as the referrer, never ours", () => {
    for (const ours of ["https://getseopen.com/features", "https://app.getseopen.com/sign-in", "https://www.getseopen.com/", "https://GETSEOPEN.COM/"]) {
      expect(capture.readVisit("https://getseopen.com/pricing", ours, OWN).referrerHost).toBeNull();
    }
    // The page's own host counts as ours even when it isn't listed (local dev, previews).
    expect(capture.readVisit("http://127.0.0.1:4100/landing", "http://127.0.0.1:4100/pricing", []).referrerHost).toBeNull();
    // Not a suffix trick: notgetseopen.com isn't ours.
    expect(capture.readVisit("https://getseopen.com/", "https://notgetseopen.com/", OWN).referrerHost).toBe("notgetseopen.com");
    expect(capture.readVisit("https://getseopen.com/", "not a url", OWN).referrerHost).toBeNull();
  });
});

describe("captureFirstVisit", () => {
  it("keeps the first page load's visit and never overwrites it", () => {
    expect(capture.firstVisit()).toBeNull();
    capture.captureFirstVisit("https://getseopen.com/blog/x?utm_source=reddit", "https://www.reddit.com/", OWN);
    capture.captureFirstVisit("https://getseopen.com/pricing?utm_source=later", "https://later.example/", OWN);
    expect(capture.firstVisit()).toEqual({ source: "reddit", referrerHost: "www.reddit.com", landingPath: "/blog/x" });
  });
});

describe("withFirstVisit", () => {
  it("leaves links alone before anything is captured", () => {
    expect(capture.withFirstVisit(SIGN_UP, OWN)).toBe(SIGN_UP);
  });

  it("adds the visit to our /sign-up links only", () => {
    capture.captureFirstVisit("https://getseopen.com/pricing?utm_source=newsletter", "https://news.example.com/", OWN);
    expect(new URL(capture.withFirstVisit(SIGN_UP, OWN)).searchParams.toString()).toBe("src=newsletter&ref_host=news.example.com&landing=%2Fpricing");
    for (const other of ["https://app.getseopen.com/sign-in", "https://evil.example/sign-up", "https://app.getseopen.com/sign-up/extra", "mailto:hello@getseopen.com"]) {
      expect(capture.withFirstVisit(other, OWN)).toBe(other);
    }
  });

  it("leaves out what wasn't there and keeps what the link already carries", () => {
    capture.captureFirstVisit("https://getseopen.com/", "", OWN);
    expect(new URL(capture.withFirstVisit(SIGN_UP, OWN)).searchParams.toString()).toBe("landing=%2F");
    const carried = `${SIGN_UP}?landing=%2Ftools`;
    expect(capture.withFirstVisit(carried, OWN)).toBe(carried);
  });
});
