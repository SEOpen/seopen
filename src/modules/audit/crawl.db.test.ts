import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** What a failed crawl or Lighthouse run leaves on its row, against seopen_test. Nothing here talks to DataForSEO. */

vi.mock("server-only", () => ({}));
const dfsPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dataforseo/client", async (original) => ({ ...(await original<typeof import("@/lib/dataforseo/client")>()), dfsPost }));
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/web/fetch", async (original) => ({ ...(await original<typeof import("@/lib/web/fetch")>()), safeFetch }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { failUnqueuedCrawl, activeCrawl, importCrawl, runLighthouse, confirmPageChecks, pollActiveCrawls } = await import("./crawl");
const { CRAWL_NOT_QUEUED, plainLighthouseFailure } = await import("@/lib/dataforseo/failure-copy");

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `crawl-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Site", domain: `crawl-${ws.id}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const crawl = async (values: Partial<typeof s.auditCrawls.$inferInsert> = {}) => {
    const [row] = await db.insert(s.auditCrawls).values({ ...scope, status: "queued", target: project.domain, maxPages: 10, ...values }).returning();
    return row;
  };
  return { scope, project, crawl };
}

const crawlRow = async (id: number) => (await db.select().from(s.auditCrawls).where(eq(s.auditCrawls.id, id)))[0];

describe.skipIf(!ready)("failUnqueuedCrawl", () => {
  it("closes the row as failed, so the project doesn't look like it's crawling", async () => {
    const { scope, crawl } = await seed();
    const row = await crawl();
    await failUnqueuedCrawl(scope, row.id);
    expect(await crawlRow(row.id)).toMatchObject({ status: "failed", error: CRAWL_NOT_QUEUED });
    expect((await crawlRow(row.id)).finishedAt).toBeInstanceOf(Date);
    expect(await activeCrawl(scope)).toBeNull();
  });

  it("leaves a crawl a job has already claimed", async () => {
    const { scope, crawl } = await seed();
    const row = await crawl({ status: "posting" });
    await failUnqueuedCrawl(scope, row.id);
    expect(await crawlRow(row.id)).toMatchObject({ status: "posting", error: null });
  });

  it("leaves another workspace's crawl", async () => {
    const mine = await seed();
    const theirs = await seed();
    const row = await theirs.crawl();
    await failUnqueuedCrawl(mine.scope, row.id);
    expect((await crawlRow(row.id)).status).toBe("queued");
  });
});

describe.skipIf(!ready)("pollActiveCrawls", () => {
  it("past its deadline, polls nothing and counts what it left as running", async () => {
    const { crawl } = await seed();
    const row = await crawl({ status: "crawling", taskId: `t-${randomUUID()}`, startedAt: new Date() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dfsPost.mockReset();
    const running = await pollActiveCrawls({ deadline: 0 });
    expect(running).toBeGreaterThanOrEqual(1);
    expect(dfsPost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stopped at its deadline/));
    expect((await crawlRow(row.id)).status).toBe("crawling");
    warn.mockRestore();
    await db.update(s.auditCrawls).set({ status: "failed" }).where(eq(s.auditCrawls.id, row.id));
  });
});

describe.skipIf(!ready)("runLighthouse", () => {
  it("keeps the code of a rejected task, so the page doesn't offer a retry that can't work", async () => {
    const { scope, project } = await seed();
    const [row] = await db.insert(s.auditLighthouse).values({ ...scope, url: `https://${project.domain}/`, status: "queued" }).returning();
    dfsPost.mockResolvedValueOnce({ tasks: [{ status_code: 40501, status_message: "Invalid Field." }] });
    await expect(runLighthouse(scope, row.id)).rejects.toThrow("Invalid Field.");
    const [stored] = await db.select().from(s.auditLighthouse).where(eq(s.auditLighthouse.id, row.id));
    expect(stored).toMatchObject({ status: "failed", error: "40501 Invalid Field." });
    expect(plainLighthouseFailure(stored.error)).toBe("Lighthouse rejected this page, so running it again won't help. Check the page's address.");
  });
});

describe.skipIf(!ready)("importCrawl", () => {
  const items = (rows: object[]) => ({ tasks: [{ status_code: 20000, result: [{ total_items_count: rows.length, items: rows }] }] });

  /** A crawl where /a and /b are flagged as similar and every page links nofollow to /account, which robots.txt blocks. */
  async function imported(lookup: (url: string) => object) {
    const { crawl, project } = await seed();
    const at = (path: string) => `https://${project.domain}${path}`;
    const page = (path: string, flagged: boolean) => ({ url: at(path), resource_type: "html", status_code: 200, duplicate_content: flagged, meta: null, checks: {}, page_timing: null });
    dfsPost.mockReset();
    dfsPost.mockImplementation(async (path: string, tasks: { url?: string }[]) => {
      if (path === "on_page/pages") return items([page("/a", true), page("/b", true), page("/c", false)]);
      if (path === "on_page/links") return items([{ type: "anchor", link_from: at("/a"), link_to: at("/account"), direction: "internal", dofollow: false, is_broken: false, text: "Account" }]);
      if (path === "on_page/non_indexable") return items([{ url: at("/account"), reason: "robots_txt" }]);
      if (path === "on_page/duplicate_content") return lookup(tasks[0].url!);
      return items([]);
    });
    const row = await crawl({ status: "importing", taskId: "task-1" });
    await importCrawl(row, { crawl_status: { pages_crawled: 3 } } as never);
    const issues = await db.select().from(s.auditIssues).where(eq(s.auditIssues.crawlId, row.id));
    return { at, issues, crawl: await crawlRow(row.id), lookups: dfsPost.mock.calls.filter(([path]) => path === "on_page/duplicate_content") };
  }

  it("imports a crawl once when two workers import it at the same time", async () => {
    const { crawl, project } = await seed();
    const at = (path: string) => `https://${project.domain}${path}`;
    const page = (path: string) => ({ url: at(path), resource_type: "html", status_code: 404, meta: null, checks: {}, page_timing: null });
    dfsPost.mockReset();
    dfsPost.mockImplementation(async (path: string) => {
      if (path === "on_page/pages") return items([page("/a"), page("/b")]);
      if (path === "on_page/links") return items([{ type: "anchor", link_from: at("/a"), link_to: at("/b"), direction: "internal", dofollow: true, is_broken: true, text: "B" }]);
      return items([]);
    });
    const row = await crawl({ status: "importing", taskId: "task-twice" });
    const summary = { crawl_status: { pages_crawled: 2 } } as never;
    await Promise.all([importCrawl(row, summary), importCrawl(row, summary)]);
    const count = async (t: typeof s.auditPages | typeof s.auditLinks | typeof s.auditIssues) => (await db.select().from(t).where(eq(t.crawlId, row.id))).length;
    expect(await count(s.auditPages)).toBe(2);
    expect(await count(s.auditLinks)).toBe(1);
    const done = await crawlRow(row.id);
    expect(done.status).toBe("done");
    // A third import, started after the crawl is done, stops at its claim: no lookups, no rewrite.
    dfsPost.mockClear();
    await importCrawl(row, summary);
    expect(dfsPost).not.toHaveBeenCalled();
    expect(await crawlRow(row.id)).toMatchObject({ status: "done", finishedAt: done.finishedAt });
  });

  it("keeps a duplicate meta tag finding only on pages that really repeat a title or description", async () => {
    const { crawl, project } = await seed();
    const at = (path: string) => `https://${project.domain}${path}`;
    const flagged = (path: string) => ({ url: at(path), resource_type: "html", status_code: 200, meta: null, checks: { duplicate_meta_tags: true }, page_timing: null });
    dfsPost.mockReset();
    dfsPost.mockImplementation(async (path: string) => (path === "on_page/pages" ? items([flagged("/theme"), flagged("/titles"), flagged("/down")]) : items([])));
    const html: Record<string, string> = {
      [at("/theme")]: '<head><title>One</title><meta name="description" content="d"><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)"></head>',
      [at("/titles")]: "<head><title>One</title><title>Two</title></head>",
    };
    safeFetch.mockReset();
    safeFetch.mockImplementation(async (url: string) => {
      if (!html[url]) throw new Error("That site didn't answer.");
      return { status: 200, body: html[url], headers: {} };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = await crawl({ status: "importing", taskId: "task-meta" });
    await importCrawl(row, { crawl_status: { pages_crawled: 3 } } as never);
    warn.mockRestore();
    const issues = await db.select().from(s.auditIssues).where(eq(s.auditIssues.crawlId, row.id));
    // The theme-color pair is meant to repeat; a page SEOpen couldn't fetch keeps DataForSEO's flag.
    expect(issues.filter((i) => i.code === "duplicate-meta-tags").map((i) => i.url).sort()).toEqual([at("/down"), at("/titles")]);
  });

  it("keeps a missing alt finding only on pages with an image that has no alt attribute, and names it", async () => {
    const { crawl, project } = await seed();
    const at = (path: string) => `https://${project.domain}${path}`;
    const flagged = (path: string, checks: Record<string, boolean> = { no_image_alt: true }) => ({ url: at(path), resource_type: "html", status_code: 200, meta: null, checks, page_timing: null });
    dfsPost.mockReset();
    dfsPost.mockImplementation(async (path: string) =>
      path === "on_page/pages" ? items([flagged("/decorative"), flagged("/missing"), flagged("/scripted"), flagged("/cut"), flagged("/down"), flagged("/both", { no_image_alt: true, duplicate_meta_tags: true })]) : items([]),
    );
    const html: Record<string, { body: string; truncated?: boolean }> = {
      [at("/decorative")]: { body: '<body><img src="/a.png" alt=""><img src="/b.png" alt></body>' },
      [at("/missing")]: { body: '<body><img src="/a.png" alt=""><img src="/hero.jpg"></body>' },
      [at("/scripted")]: { body: '<body><div id="root"></div></body>' },
      [at("/cut")]: { body: '<body><img src="/a.png" alt="">', truncated: true },
      [at("/both")]: { body: '<head><title>One</title></head><body><img src="/a.png" alt=""></body>' },
    };
    safeFetch.mockReset();
    safeFetch.mockImplementation(async (url: string) => {
      if (!html[url]) throw new Error("That site didn't answer.");
      return { status: 200, body: html[url].body, truncated: html[url].truncated ?? false, headers: {} };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = await crawl({ status: "importing", taskId: "task-alt" });
    await importCrawl(row, { crawl_status: { pages_crawled: 6 } } as never);
    warn.mockRestore();
    const issues = await db.select().from(s.auditIssues).where(eq(s.auditIssues.crawlId, row.id));
    // alt="" and a bare alt are decorative; no images in the HTML, a cut-short page or a failed fetch keep DataForSEO's flag.
    expect(issues.filter((i) => i.code === "missing-alt").map((i) => [i.url, i.detail]).sort()).toEqual([
      [at("/cut"), null],
      [at("/down"), null],
      [at("/missing"), "/hero.jpg"],
      [at("/scripted"), null],
    ]);
    // A page flagged for both checks is fetched once and cleared of both. The access checks' status-only requests don't count.
    expect(issues.some((i) => i.url === at("/both"))).toBe(false);
    expect(safeFetch.mock.calls.filter(([url, opts]) => url === at("/both") && !opts?.headOnly)).toHaveLength(1);
  });

  it("doesn't clear a missing alt finding on a crawl that ran JavaScript, but still names what the raw HTML shows", async () => {
    const { crawl, project } = await seed();
    const at = (path: string) => `https://${project.domain}${path}`;
    const flagged = (path: string) => ({ url: at(path), resource_type: "html", status_code: 200, meta: null, checks: { no_image_alt: true }, page_timing: null });
    dfsPost.mockReset();
    dfsPost.mockImplementation(async (path: string) => (path === "on_page/pages" ? items([flagged("/decorative"), flagged("/missing")]) : items([])));
    const html: Record<string, string> = {
      [at("/decorative")]: '<body><img src="/a.png" alt=""></body>',
      [at("/missing")]: '<body><img src="/hero.jpg"></body>',
    };
    safeFetch.mockReset();
    safeFetch.mockImplementation(async (url: string) => ({ status: 200, body: html[url], truncated: false, headers: {} }));
    const row = await crawl({ status: "importing", taskId: "task-alt-js", enableJavascript: true });
    await importCrawl(row, { crawl_status: { pages_crawled: 2 } } as never);
    const issues = await db.select().from(s.auditIssues).where(eq(s.auditIssues.crawlId, row.id));
    // DataForSEO saw the rendered page; the raw HTML can't show it was wrong.
    expect(issues.filter((i) => i.code === "missing-alt").map((i) => [i.url, i.detail]).sort()).toEqual([
      [at("/decorative"), null],
      [at("/missing"), "/hero.jpg"],
    ]);
  });

  it("names each flagged page's closest match and skips the blocked nofollow target", async () => {
    const out = await imported((url) => {
      const other = url.endsWith("/a") ? url.replace(/\/a$/, "/b") : url.replace(/\/b$/, "/a");
      return items([{ url, total_count: 1, pages: [{ similarity: 7, page: [{ url: other }] }] }]);
    });
    expect(out.crawl.status).toBe("done");
    expect(out.lookups.map(([, tasks]) => (tasks as { url: string }[])[0].url).sort()).toEqual([out.at("/a"), out.at("/b")]);
    const similar = out.issues.filter((i) => i.code === "duplicate-content").sort((x, y) => x.url.localeCompare(y.url));
    expect(similar.map((i) => i.detail)).toEqual([`${out.at("/b")} (7 of 10)`, `${out.at("/a")} (7 of 10)`]);
    expect(out.issues.some((i) => i.code === "nofollow-internal")).toBe(false);
  });

  it("adds the crawler and AI access findings and keeps what robots.txt said on the crawl, with when it was fetched", async () => {
    const { crawl, project } = await seed();
    const at = (path: string) => `https://${project.domain}${path}`;
    dfsPost.mockReset();
    dfsPost.mockImplementation(async (path: string) => (path === "on_page/pages" ? items([{ url: at("/"), resource_type: "html", status_code: 200, meta: null, checks: {}, page_timing: null }]) : items([])));
    safeFetch.mockReset();
    safeFetch.mockImplementation(async (url: string, opts: { userAgent?: string } = {}) => {
      const res = (status: number, body = "", type = "text/html") => ({ url, status, body, headers: { "content-type": type }, truncated: false, redirects: [], ms: 1 });
      if (url.endsWith("/robots.txt")) return res(200, "User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /", "text/plain");
      if (url.endsWith("/sitemap.xml")) return res(404);
      if (opts.userAgent?.includes("Claude-SearchBot")) return res(403);
      return res(200, "<h1>Home</h1>");
    });
    const row = await crawl({ status: "importing", taskId: "task-access" });
    await importCrawl(row, { crawl_status: { pages_crawled: 1 } } as never);
    const issues = await db.select().from(s.auditIssues).where(eq(s.auditIssues.crawlId, row.id));
    expect(issues.filter((i) => ["search-bot-blocked", "bot-turned-away"].includes(i.code)).map((i) => [i.code, i.detail]).sort()).toEqual([
      ["bot-turned-away", "Claude-SearchBot 403"],
      ["search-bot-blocked", "PerplexityBot (Disallow: /)"],
    ]);
    const access = ((await crawlRow(row.id)).summary as { access: { robots: { status: number; fetchedAt: string }; crawlers: { token: string; allowed: boolean }[] } }).access;
    expect(access.robots.status).toBe(200);
    expect(Date.parse(access.robots.fetchedAt)).not.toBeNaN();
    expect(access.crawlers.find((c) => c.token === "GPTBot")?.allowed).toBe(false);
  });

  it("finishes the import with the finding but no match when a lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await imported(() => ({ tasks: [{ status_code: 50000, status_message: "Internal Error." }] }));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(out.crawl.status).toBe("done");
    expect(out.issues.filter((i) => i.code === "duplicate-content").map((i) => i.detail)).toEqual([null, null]);
  });
});

describe("confirmPageChecks", () => {
  const page = (path: string, checks: Record<string, boolean>) => ({ url: `https://example.com${path}`, resource_type: "html", status_code: 200, meta: null, checks, page_timing: null }) as never;
  const crawl = { id: 0, enableJavascript: false };

  it("fetches pages flagged for duplicate meta tags first, so pages flagged only for alt can't crowd them out of the cap", async () => {
    const alt = Array.from({ length: 250 }, (_, i) => page(`/alt-${i}`, { no_image_alt: true }));
    const meta = page("/meta", { duplicate_meta_tags: true });
    safeFetch.mockReset();
    safeFetch.mockResolvedValue({ status: 200, body: "<head><title>One</title></head>", truncated: false, headers: {} });
    const { pages } = await confirmPageChecks(crawl, [...alt, meta]);
    expect(safeFetch).toHaveBeenCalledTimes(200);
    expect(safeFetch.mock.calls[0][0]).toBe("https://example.com/meta");
    expect((pages.at(-1) as { checks: Record<string, boolean> }).checks.duplicate_meta_tags).toBe(false);
  });

  it("recounts a page under the thin-content line with link text, and keeps the higher count", async () => {
    const thin = (path: string, words: number) => ({ ...(page(path, {}) as object), meta: { content: { plain_text_word_count: words, plain_text_rate: 0.1 } } }) as never;
    const cards = Array.from({ length: 30 }, (_, i) => `<a href="/s/${i}">Card ${i} says ten words about this one service here</a>`).join("");
    safeFetch.mockReset();
    safeFetch.mockImplementation(async (url: string) => ({
      status: 200,
      body: url.endsWith("/grid") ? `<body><main>${cards}</main></body>` : "<body><main>Short</main></body>",
      truncated: false,
      headers: {},
    }));
    const { pages } = await confirmPageChecks(crawl, [thin("/grid", 40), thin("/short", 12), thin("/fine", 900)]);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    const words = (pages as { meta: { content: { plain_text_word_count: number } } }[]).map((p) => p.meta.content.plain_text_word_count);
    expect(words).toEqual([300, 12, 900]);
  });

  it("starts no batch after the time budget runs out, and leaves the pages it didn't fetch flagged", async () => {
    const flagged = Array.from({ length: 12 }, (_, i) => page(`/p-${i}`, { duplicate_meta_tags: true }));
    let now = 0;
    safeFetch.mockReset();
    safeFetch.mockImplementation(async () => {
      now += 30_000;
      return { status: 200, body: "<head><title>One</title></head>", truncated: false, headers: {} };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pages } = await confirmPageChecks(crawl, flagged, { ms: 120_000, now: () => now });
    warn.mockRestore();
    // The first batch of five takes 150 s, so the second never starts.
    expect(safeFetch).toHaveBeenCalledTimes(5);
    const checks = (pages as { checks: Record<string, boolean> }[]).map((p) => p.checks.duplicate_meta_tags);
    expect(checks).toEqual([...Array(5).fill(false), ...Array(7).fill(true)]);
  });
});
