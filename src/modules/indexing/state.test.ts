import { describe, expect, it } from "vitest";
import {
  adviceFor,
  hostOf,
  indexNowAnswer,
  indexNowBatch,
  indexStatus,
  keyFileMatches,
  mainHost,
  newIndexNowKey,
  nextIndexedAt,
  linkFrom,
  pickForInspection,
  requestPending,
  requestRank,
  sectionOf,
  STATUS_ADVICE,
  type PickRow,
} from "./state";

const NOW = new Date("2026-11-16T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const at = daysAgo(1);

describe("adviceFor", () => {
  it("follows Google's coverage words for a waiting page", () => {
    expect(adviceFor("waiting", "URL is unknown to Google")).toMatch(/hasn't found this page/);
    expect(adviceFor("waiting", "Discovered - currently not indexed")).toMatch(/hasn't crawled it/);
    expect(adviceFor("waiting", "Crawled - currently not indexed")).toMatch(/crawled the page/);
    expect(adviceFor("waiting", null)).toBe(STATUS_ADVICE.waiting);
    expect(adviceFor("blocked", "URL is unknown to Google")).toBe(STATUS_ADVICE.blocked);
  });
});

describe("indexStatus", () => {
  it("reads Google's answer", () => {
    expect(indexStatus({ inspectedAt: null, verdict: null, coverageState: null })).toBe("unchecked");
    expect(indexStatus({ inspectedAt: at, verdict: "ERROR", coverageState: null })).toBe("error");
    expect(indexStatus({ inspectedAt: at, verdict: "PASS", coverageState: "Submitted and indexed" })).toBe("indexed");
    for (const c of ["URL is unknown to Google", "Discovered - currently not indexed", "Crawled - currently not indexed"]) {
      expect(indexStatus({ inspectedAt: at, verdict: "NEUTRAL", coverageState: c })).toBe("waiting");
    }
    expect(indexStatus({ inspectedAt: at, verdict: "NEUTRAL", coverageState: "Duplicate, Google chose different canonical than user" })).toBe("duplicate");
    expect(indexStatus({ inspectedAt: at, verdict: "NEUTRAL", coverageState: "Alternate page with proper canonical tag" })).toBe("duplicate");
    expect(indexStatus({ inspectedAt: at, verdict: "FAIL", coverageState: "Not found (404)" })).toBe("blocked");
    expect(indexStatus({ inspectedAt: at, verdict: "NEUTRAL", coverageState: "Excluded by ‘noindex’ tag" })).toBe("blocked");
    expect(indexStatus({ inspectedAt: at, verdict: "NEUTRAL", coverageState: "Something new", indexingState: "BLOCKED_BY_META_TAG" })).toBe("blocked");
    expect(indexStatus({ inspectedAt: at, verdict: "NEUTRAL", coverageState: "Something new", robotsTxtState: "DISALLOWED" })).toBe("blocked");
    expect(indexStatus({ inspectedAt: at, verdict: "NEUTRAL", coverageState: "Something new", pageFetchState: "SUCCESSFUL" })).toBe("other");
  });
});

describe("pickForInspection", () => {
  const row = (url: string, over: Partial<PickRow> = {}): PickRow => ({ url, firstSeenAt: daysAgo(30), inspectedAt: null, verdict: null, coverageState: null, ...over });

  it("takes new pages first, then pages Google hadn't indexed, then indexed pages due a recheck", () => {
    const rows = [
      row("indexed-old", { inspectedAt: daysAgo(20), verdict: "PASS" }),
      row("indexed-fresh", { inspectedAt: daysAgo(3), verdict: "PASS" }),
      row("waiting-old", { inspectedAt: daysAgo(5), verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" }),
      row("waiting-fresh", { inspectedAt: daysAgo(1), verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" }),
      row("new-later", { firstSeenAt: daysAgo(2) }),
      row("new-first", { firstSeenAt: daysAgo(10) }),
    ];
    expect(pickForInspection(rows, NOW, 10).map((r) => r.url)).toEqual(["new-first", "new-later", "waiting-old", "indexed-old"]);
    expect(pickForInspection(rows, NOW, 1).map((r) => r.url)).toEqual(["new-first"]);
    expect(pickForInspection(rows, NOW, 0)).toEqual([]);
  });
});

describe("nextIndexedAt", () => {
  it("marks a page indexed only when it wasn't before", () => {
    expect(nextIndexedAt({ verdict: "NEUTRAL", indexedAt: null }, "PASS", NOW)).toEqual(NOW);
    expect(nextIndexedAt({ verdict: null, indexedAt: null }, "PASS", NOW)).toBeNull();
    expect(nextIndexedAt({ verdict: "PASS", indexedAt: at }, "PASS", NOW)).toEqual(at);
    expect(nextIndexedAt({ verdict: "PASS", indexedAt: at }, "NEUTRAL", NOW)).toBeNull();
  });
});

describe("IndexNow", () => {
  const row = (url: string, lastmod: string | null, submittedLastmod: string | null, submitted: boolean) => ({ url, lastmod, submittedLastmod, submittedAt: submitted ? at : null });

  it("sends pages on the key's host that are new or changed", () => {
    const rows = [
      row("https://example.com/new", null, null, false),
      row("https://example.com/same", "2026-11-01", "2026-11-01", true),
      row("https://example.com/changed", "2026-11-10", "2026-11-01", true),
      row("https://example.com/no-lastmod", null, null, true),
      row("https://blog.example.com/elsewhere", null, null, false),
    ];
    expect(indexNowBatch(rows, "Example.com").map((r) => r.url)).toEqual(["https://example.com/new", "https://example.com/changed"]);
    expect(indexNowBatch(rows, "example.com", 1)).toHaveLength(1);
  });

  it("finds the main host and reads hosts safely", () => {
    expect(mainHost(["https://www.a.com/", "https://www.a.com/x", "https://a.com/y"])).toBe("www.a.com");
    expect(mainHost([])).toBeNull();
    expect(hostOf("mailto:x@a.com")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });

  it("makes keys IndexNow accepts and checks the key file", () => {
    const key = newIndexNowKey();
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(newIndexNowKey()).not.toBe(key);
    expect(keyFileMatches(200, `${key}\n`, key)).toBe(true);
    expect(keyFileMatches(200, "<html>not found</html>", key)).toBe(false);
    expect(keyFileMatches(404, key, key)).toBe(false);
  });

  it("reads IndexNow's answers", () => {
    expect(indexNowAnswer(200).ok).toBe(true);
    expect(indexNowAnswer(202).ok).toBe(true);
    expect(indexNowAnswer(403)).toMatchObject({ ok: false, keyRejected: true });
    expect(indexNowAnswer(429)).toMatchObject({ ok: false, keyRejected: false });
  });
});

describe("requests", () => {
  const row = (url: string, over: Partial<PickRow> = {}): PickRow => ({ url, firstSeenAt: daysAgo(30), inspectedAt: daysAgo(1.5), verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed", ...over });

  it("rechecks a requested page after a day, ahead of other pages Google hadn't indexed", () => {
    const rows = [row("waiting-old", { inspectedAt: daysAgo(5) }), row("requested", { requestedAt: daysAgo(1.2) }), row("not-requested")];
    expect(pickForInspection(rows, NOW, 10).map((r) => r.url)).toEqual(["requested", "waiting-old"]);
    // Requested before Google's last answer: an ordinary page again.
    expect(pickForInspection([row("old-request", { requestedAt: daysAgo(3) })], NOW, 10)).toEqual([]);
  });

  it("asks first for pages Google hasn't found, then discovered, then crawled", () => {
    expect(["Crawled - currently not indexed", "URL is unknown to Google", "Discovered - currently not indexed"].sort((a, b) => requestRank(a) - requestRank(b))).toEqual([
      "URL is unknown to Google",
      "Discovered - currently not indexed",
      "Crawled - currently not indexed",
    ]);
  });

  it("counts a request for a week", () => {
    expect(requestPending(daysAgo(6), NOW)).toBe(true);
    expect(requestPending(daysAgo(8), NOW)).toBe(false);
    expect(requestPending(null, NOW)).toBe(false);
  });

  it("suggests indexed pages to link from: same section, then clicks, then the home page", () => {
    const indexed = [
      { url: "https://a.com/", clicks: 5 },
      { url: "https://a.com/pricing", clicks: 40 },
      { url: "https://a.com/glossary/ctr", clicks: 2 },
      { url: "https://a.com/glossary/clicks", clicks: 90 },
      { url: "https://a.com/blog/x", clicks: 0 },
    ];
    expect(sectionOf("https://a.com/glossary/clicks")).toBe("glossary");
    expect(linkFrom("https://a.com/glossary/clicks", indexed)).toEqual(["https://a.com/glossary/ctr", "https://a.com/pricing", "https://a.com/"]);
    expect(linkFrom("https://a.com/features/x", [{ url: "https://a.com/blog/x", clicks: 0 }, { url: "https://a.com/", clicks: 0 }])).toEqual(["https://a.com/", "https://a.com/blog/x"]);
  });
});
