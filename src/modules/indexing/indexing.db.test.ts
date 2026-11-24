import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The indexing module against seopen_test: the sitemap read into pages, Google's answers turned into
 * the Not indexed list, a page marked done once Google indexes it, and IndexNow sending only after
 * the key file is found and the owner turns it on, then only new and changed pages. The web and
 * Google are stubbed, so nothing leaves the machine.
 */

type Reply = { status: number; body?: string; url?: string; headers?: Record<string, string> };
const web = vi.hoisted(() => ({ pages: new Map<string, Reply>(), posts: [] as { url: string; body: string }[], postStatus: 200 }));
const google = vi.hoisted(() => ({ answers: new Map<string, { verdict: string; coverageState: string }>(), quota: false, calls: [] as string[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: async () => "job" }));
vi.mock("@/lib/web/fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/web/fetch")>()),
  safeFetch: async (url: string, opts: { method?: string; body?: string } = {}) => {
    if (opts.method === "POST") {
      web.posts.push({ url, body: opts.body ?? "" });
      return { url, status: web.postStatus, headers: {}, body: "", truncated: false, redirects: [], ms: 1 };
    }
    const r = web.pages.get(url) ?? { status: 404, body: "not found" };
    return { url: r.url ?? url, status: r.status, headers: { "content-type": "text/plain", ...r.headers }, body: r.body ?? "", truncated: false, redirects: [], ms: 1 };
  },
}));
vi.mock("@/modules/google/apis", () => ({
  googleApis: async () => ({
    gsc: {
      inspect: async (_property: string, url: string) => {
        google.calls.push(url);
        if (google.quota) {
          const { GoogleQuotaError } = await import("@/modules/google/types");
          throw new GoogleQuotaError("Quota exceeded");
        }
        const a = google.answers.get(url) ?? { verdict: "PASS", coverageState: "Submitted and indexed" };
        return { ...a, indexingState: "INDEXING_ALLOWED", robotsTxtState: "ALLOWED", pageFetchState: "SUCCESSFUL", lastCrawlTime: "2026-11-10T00:00:00Z", googleCanonical: url, userCanonical: url, crawledAs: "MOBILE", inspectionResultLink: `https://search.google.com/search-console/inspect?id=${encodeURIComponent(url)}`, richResults: null };
      },
    },
  }),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { syncIndexing, inspectDue, ensureSettings, submitChanged } = await import("./sync");
const { indexingView, linkHints } = await import("./data");
const { markRequestedOp, setIndexNowOp, submitIndexNowOp } = await import("./ops");

const actor = { userId: "test", source: "app" as const };
const made: number[] = [];

async function setup(gsc = true) {
  const [ws] = await db.insert(s.workspaces).values({ name: `indexing-${randomUUID().slice(0, 8)}`, plan: "free" }).returning();
  made.push(ws.id);
  const domain = `indexing-${ws.id}.example`;
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: domain, domain, gscProperty: gsc ? `sc-domain:${domain}` : null })
    .returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const url = (path: string) => `https://${domain}${path}`;
  return { scope, project, url, domain };
}

type Site = Awaited<ReturnType<typeof setup>>;

function serveSitemap(site: Site, pages: { path: string; lastmod?: string }[]) {
  web.pages.set(site.url("/robots.txt"), { status: 200, body: `User-agent: *\nAllow: /\nSitemap: ${site.url("/sitemap_index.xml")}\n` });
  web.pages.set(site.url("/sitemap_index.xml"), { status: 200, body: `<sitemapindex><sitemap><loc>${site.url("/pages.xml")}</loc></sitemap></sitemapindex>` });
  web.pages.set(site.url("/pages.xml"), {
    status: 200,
    body: `<urlset>${pages.map((p) => `<url><loc>${site.url(p.path)}</loc>${p.lastmod ? `<lastmod>${p.lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>`,
  });
}

const pagesOf = async (site: Site) => (await db.select().from(s.indexingPages).where(eq(s.indexingPages.projectId, site.project.id))).sort((a, b) => a.url.localeCompare(b.url));
const later = (days: number) => new Date(Date.now() + days * 86_400_000);

beforeEach(() => {
  web.pages.clear();
  web.posts.length = 0;
  web.postStatus = 200;
  google.answers.clear();
  google.quota = false;
  google.calls.length = 0;
});

afterAll(async () => {
  if (ready && made.length) await db.delete(s.workspaces).where(inArray(s.workspaces.id, made));
});

describe.skipIf(!ready)("indexing", () => {
  it("reads the sitemap into pages, keeping lastmods and dropping pages that leave it", async () => {
    const site = await setup(false);
    serveSitemap(site, [{ path: "/", lastmod: "2026-11-01" }, { path: "/a" }, { path: "/b" }]);
    const first = await syncIndexing(site.scope, site.project);
    expect(first).toMatchObject({ pages: 3, added: 3, removed: 0 });
    expect((await pagesOf(site)).map((p) => [p.url, p.lastmod])).toEqual([
      [site.url("/"), "2026-11-01"],
      [site.url("/a"), null],
      [site.url("/b"), null],
    ]);

    serveSitemap(site, [{ path: "/", lastmod: "2026-11-12" }, { path: "/a" }]);
    expect(await syncIndexing(site.scope, site.project)).toMatchObject({ pages: 2, added: 0, removed: 1 });
    expect((await pagesOf(site)).map((p) => [p.url, p.lastmod])).toEqual([
      [site.url("/"), "2026-11-12"],
      [site.url("/a"), null],
    ]);
    // No Search Console property: nothing is inspected.
    expect(google.calls).toEqual([]);
  });

  it("keeps the pages it has when the sitemap can't be read, and says why", async () => {
    const site = await setup(false);
    serveSitemap(site, [{ path: "/a" }]);
    await syncIndexing(site.scope, site.project);
    web.pages.set(site.url("/pages.xml"), { status: 500 });
    const r = await syncIndexing(site.scope, site.project);
    expect(r.sitemapError).toContain("HTTP 500");
    expect(await pagesOf(site)).toHaveLength(1);
    expect((await ensureSettings(site.scope)).sitemapError).toContain("HTTP 500");
  });

  it("lists the pages Google hasn't indexed with their Search Console link, then marks one done once it's indexed", async () => {
    const site = await setup();
    serveSitemap(site, [{ path: "/" }, { path: "/crawled" }, { path: "/gone" }]);
    google.answers.set(site.url("/crawled"), { verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" });
    google.answers.set(site.url("/gone"), { verdict: "FAIL", coverageState: "Not found (404)" });
    const r = await syncIndexing(site.scope, site.project);
    expect(r.inspected).toBe(3);

    const v = await indexingView(site.scope);
    expect(v.counts).toMatchObject({ pages: 3, inspected: 3, indexed: 1, notIndexed: 2, requestIndexing: 1 });
    expect(v.notIndexed.map((p) => [p.url, p.status])).toEqual([
      [site.url("/crawled"), "waiting"],
      [site.url("/gone"), "blocked"],
    ]);
    expect(v.notIndexed[0].inspectionLink).toContain("search-console");

    // Pages inspected today aren't asked about again today.
    google.calls.length = 0;
    expect((await inspectDue(site.scope, site.project.gscProperty!)).inspected).toBe(0);

    // Three days on, the pages Google hadn't indexed are asked about again, and one made it.
    google.answers.delete(site.url("/crawled"));
    const again = await inspectDue(site.scope, site.project.gscProperty!, later(3));
    expect(again.inspected).toBe(2);
    expect(google.calls.sort()).toEqual([site.url("/crawled"), site.url("/gone")]);
    const after = await indexingView(site.scope, later(3));
    expect(after.notIndexed.map((p) => p.url)).toEqual([site.url("/gone")]);
    expect(after.nowIndexed.map((p) => p.url)).toEqual([site.url("/crawled")]);
  });

  it("stops at Google's quota and says so, leaving the rest for later", async () => {
    const site = await setup();
    serveSitemap(site, [{ path: "/a" }, { path: "/b" }]);
    google.quota = true;
    const r = await syncIndexing(site.scope, site.project);
    expect(r.inspected).toBe(0);
    expect(r.inspectStopped).toContain("quota");
    expect((await pagesOf(site)).every((p) => p.inspectedAt === null)).toBe(true);
    expect((await ensureSettings(site.scope)).inspectError).toContain("quota");
  });

  it("sends nothing to IndexNow until the key file is found and the owner turns it on, then only new and changed pages", async () => {
    const site = await setup(false);
    serveSitemap(site, [{ path: "/", lastmod: "2026-11-01" }, { path: "/a" }]);
    await syncIndexing(site.scope, site.project);
    expect(web.posts).toEqual([]);

    const { indexnowKey: key } = await ensureSettings(site.scope);
    await expect(setIndexNowOp(site.scope, actor, { enabled: true })).rejects.toThrow(/key file/);
    expect((await ensureSettings(site.scope)).indexnowEnabled).toBe(false);

    web.pages.set(site.url(`/${key}.txt`), { status: 200, body: `${key}\n` });
    const dry = await setIndexNowOp(site.scope, actor, { enabled: true }, { dryRun: true });
    expect(dry.changed).toBe(true);
    expect((await ensureSettings(site.scope)).indexnowEnabled).toBe(false);
    const on = await setIndexNowOp(site.scope, actor, { enabled: true });
    expect(on).toMatchObject({ enabled: true, verified: true });

    // The next run sends both pages once.
    await syncIndexing(site.scope, site.project);
    expect(web.posts).toHaveLength(1);
    const sent = JSON.parse(web.posts[0].body);
    expect(web.posts[0].url).toBe("https://api.indexnow.org/indexnow");
    expect(sent).toMatchObject({ host: site.domain, key, keyLocation: site.url(`/${key}.txt`) });
    expect(sent.urlList.sort()).toEqual([site.url("/"), site.url("/a")]);

    // Nothing changed: nothing goes. A new lastmod and a new page do.
    await syncIndexing(site.scope, site.project);
    expect(web.posts).toHaveLength(1);
    serveSitemap(site, [{ path: "/", lastmod: "2026-11-14" }, { path: "/a" }, { path: "/new" }]);
    await syncIndexing(site.scope, site.project);
    expect(web.posts).toHaveLength(2);
    expect(JSON.parse(web.posts[1].body).urlList.sort()).toEqual([site.url("/"), site.url("/new")]);
  });

  it("forgets the key when IndexNow refuses it, and sends named pages on request", async () => {
    const site = await setup(false);
    serveSitemap(site, [{ path: "/a" }]);
    await syncIndexing(site.scope, site.project);
    const { indexnowKey: key } = await ensureSettings(site.scope);
    web.pages.set(site.url(`/${key}.txt`), { status: 200, body: key });

    // Without urls, the preview counts the sitemap pages waiting to go, as get_indexing does.
    const waiting = await submitIndexNowOp(site.scope, { ...actor, source: "mcp" }, {}, { dryRun: true });
    expect(waiting).toMatchObject({ sent: 0, wouldSend: 1 });
    expect(waiting.message).toMatch(/^Would send 1 sitemap page new or changed since last sent/);

    const preview = await submitIndexNowOp(site.scope, { ...actor, source: "mcp" }, { urls: [site.url("/a"), "https://elsewhere.example/x"] }, { dryRun: true });
    expect(preview).toMatchObject({ sent: 0, wouldSend: 1 });
    expect(web.posts).toEqual([]);

    const done = await submitIndexNowOp(site.scope, { ...actor, source: "mcp" }, { urls: [site.url("/a"), "https://elsewhere.example/x"] });
    expect(done).toMatchObject({ ok: true, sent: 1 });
    expect(JSON.parse(web.posts[0].body).urlList).toEqual([site.url("/a")]);
    expect(await submitIndexNowOp(site.scope, { ...actor, source: "mcp" }, {}, { dryRun: true })).toMatchObject({ wouldSend: 0, message: "Nothing new or changed in the sitemap to send." });

    web.postStatus = 403;
    const refused = await submitChanged(site.scope, await ensureSettings(site.scope), [site.url("/a")]);
    expect(refused.ok).toBe(false);
    const after = await ensureSettings(site.scope);
    expect(after.indexnowVerifiedAt).toBeNull();
    expect(after.indexnowError).toContain("key file");
  });
  it("moves a page marked requested out of the queue, rechecks it the next day, and suggests pages to link from", async () => {
    const site = await setup();
    serveSitemap(site, [{ path: "/" }, { path: "/glossary/a" }, { path: "/glossary/b" }, { path: "/glossary/new" }, { path: "/guides/x" }, { path: "/gone" }]);
    google.answers.set(site.url("/glossary/new"), { verdict: "NEUTRAL", coverageState: "URL is unknown to Google" });
    google.answers.set(site.url("/guides/x"), { verdict: "NEUTRAL", coverageState: "Discovered - currently not indexed" });
    google.answers.set(site.url("/gone"), { verdict: "FAIL", coverageState: "Not found (404)" });
    await syncIndexing(site.scope, site.project);
    await db.insert(s.gscPages).values({ ...site.scope, date: new Date().toISOString().slice(0, 10), page: site.url("/glossary/b"), clicks: 30, impressions: 300, ctr: 0.1, position: 5 });

    let v = await indexingView(site.scope);
    expect(v.toRequest.map((p) => p.url)).toEqual([site.url("/glossary/new"), site.url("/guides/x")]);
    expect(v.others.map((p) => p.url)).toEqual([site.url("/gone")]);
    expect(v.requestedToday).toBe(0);

    const hints = await linkHints(site.scope, [site.url("/glossary/new")]);
    expect(hints.get(site.url("/glossary/new"))).toEqual({ linksIn: null, from: [site.url("/glossary/b"), site.url("/glossary/a"), site.url("/")] });

    await expect(markRequestedOp(site.scope, actor, { urls: ["https://elsewhere.example/x"], requested: true })).rejects.toThrow(/sitemap/);
    await markRequestedOp(site.scope, actor, { urls: [site.url("/glossary/new")], requested: true });
    v = await indexingView(site.scope);
    expect(v.toRequest.map((p) => p.url)).toEqual([site.url("/guides/x")]);
    expect(v.requested.map((p) => p.url)).toEqual([site.url("/glossary/new")]);
    expect(v.requestedToday).toBe(1);

    // A day and a bit on, only the requested page is due, and Google has it now.
    google.calls.length = 0;
    google.answers.delete(site.url("/glossary/new"));
    await inspectDue(site.scope, site.project.gscProperty!, later(1.1));
    expect(google.calls).toEqual([site.url("/glossary/new")]);
    v = await indexingView(site.scope, later(1.1));
    expect(v.requested).toEqual([]);
    expect(v.nowIndexed.map((p) => p.url)).toEqual([site.url("/glossary/new")]);

    // Undo puts a page back in the queue.
    await markRequestedOp(site.scope, actor, { urls: [site.url("/guides/x")], requested: true });
    await markRequestedOp(site.scope, actor, { urls: [site.url("/guides/x")], requested: false });
    expect((await indexingView(site.scope)).toRequest.map((p) => p.url)).toEqual([site.url("/guides/x")]);
  });
});
