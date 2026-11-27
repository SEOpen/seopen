import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** What Opportunities says to change on a page close to the top: the rules, and the crawl they read, against seopen_test. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { latestCrawlPages, opportunityHints } = await import("./opportunity-hints");

const brand = new Set(["fernhill"]);
const page = "https://fernhill.example/services/boiler-repair";
const crawled = { title: "Boiler repair in Leeds | Fernhill", h1: "Boiler repair", words: 900, linksIn: 12 };
const hints = (query: string, crawl: Parameters<typeof opportunityHints>[0]["crawl"] = crawled, extra: Partial<Parameters<typeof opportunityHints>[0]> = {}) =>
  opportunityHints({ query, page, crawl, medianLinksIn: 10, brand, ...extra });

describe("what to change on a page close to the top", () => {
  it("names the words the title and H1 are missing", () => {
    expect(hints("boiler service leeds")).toEqual(["Title is missing “service”", "H1 is missing “service”, “leeds”"]);
  });

  it("finds nothing to flag when the crawl's title and H1 cover the search", () => {
    expect(hints("boiler repair")).toEqual([]);
  });

  it("says when there's no title or H1", () => {
    expect(hints("boiler repair", { ...crawled, title: null, h1: null })).toEqual(["No title", "No H1"]);
  });

  it("flags few links in and thin text by the audit's own rules", () => {
    expect(hints("boiler repair", { ...crawled, linksIn: 1, words: 120 })).toEqual(["Only 1 internal link in", "Only 120 words"]);
    // A page short on purpose isn't thin.
    expect(opportunityHints({ query: "contact fernhill", page: "https://fernhill.example/contact", crawl: { ...crawled, words: 40 }, medianLinksIn: 10, brand })).toEqual([]);
  });

  it("points at the other page when Google shows it more for the search, and says nothing about this one's title", () => {
    expect(hints("boiler service leeds", crawled, { bestPage: "https://www.fernhill.example/boiler-service/" })).toEqual([
      "Google shows /boiler-service/ more for “boiler service leeds”: work on that page, or link to it from this one",
    ]);
    // The same page under another spelling is still this page.
    expect(hints("boiler service leeds", crawled, { bestPage: "http://www.fernhill.example/services/boiler-repair/" })).toHaveLength(2);
  });

  it("gives a brand search no title or H1 hint, but still flags the page itself", () => {
    expect(hints("fernhill reviews")).toEqual([]);
    expect(hints("fernhill reviews", { ...crawled, linksIn: 0 })).toEqual(["Only 0 internal links in"]);
  });

  it("says nothing for a page the crawl didn't reach", () => {
    expect(hints("boiler service leeds", null)).toEqual([]);
  });
});

describe.skipIf(!ready)("the crawl Opportunities reads", () => {
  async function seed() {
    const [ws] = await db.insert(s.workspaces).values({ name: `opps-${randomUUID()}`, plan: "internal" }).returning();
    const domain = `${randomUUID()}.example`;
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain }).returning();
    const scope = { workspaceId: ws.id, projectId: project.id };
    const crawl = async (finishedAt: Date, pages: { url: string; title: string; linksIn?: number }[], status = "done") => {
      const [c] = await db.insert(s.auditCrawls).values({ ...scope, status, target: domain, maxPages: 10, finishedAt }).returning();
      if (pages.length) await db.insert(s.auditPages).values(pages.map((p) => ({ workspaceId: ws.id, crawlId: c.id, url: p.url, title: p.title, resourceType: "html", statusCode: 200, internalLinksIn: p.linksIn ?? 5 })));
      return c;
    };
    return { scope, domain, crawl };
  }

  it("reads the newest finished crawl, matched across http, www and a trailing slash", async () => {
    const { scope, domain, crawl } = await seed();
    await crawl(new Date("2026-11-01"), [{ url: `https://${domain}/a`, title: "Old" }]);
    const newest = await crawl(new Date("2026-11-20"), [{ url: `https://www.${domain}/a/`, title: "New", linksIn: 2 }, { url: `https://${domain}/b`, title: "B", linksIn: 8 }]);
    await crawl(new Date("2026-11-25"), [{ url: `https://${domain}/a`, title: "Unfinished" }], "crawling");
    const read = await latestCrawlPages(scope, [`http://${domain}/a`, `https://${domain}/missing`]);
    expect(read?.crawlId).toBe(newest.id);
    expect(read?.pages.get(`http://${domain}/a`)).toMatchObject({ title: "New", linksIn: 2 });
    expect(read?.pages.has(`https://${domain}/missing`)).toBe(false);
    expect(read?.medianLinksIn).toBe(5);
  });

  it("never reads another workspace's crawl", async () => {
    const mine = await seed();
    const theirs = await seed();
    await theirs.crawl(new Date("2026-11-20"), [{ url: `https://${mine.domain}/a`, title: "Theirs" }]);
    expect(await latestCrawlPages(mine.scope, [`https://${mine.domain}/a`])).toBeNull();
  });
});
