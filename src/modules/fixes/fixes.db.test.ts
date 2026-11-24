import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/** The fix loop against seopen_test: a finding becomes a record, an applied fix goes live, and its numbers come in. */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/web/fetch", () => ({ safeFetch: vi.fn(), fetchErrorMessage: () => "That site didn't answer." }));
vi.mock("@/modules/google/apis", () => ({ googleApis: vi.fn() }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { safeFetch } = await import("@/lib/web/fetch");
const { googleApis } = await import("@/modules/google/apis");
const { catchUpAuditFixes, refreshPageImpressions, syncAuditFixes, syncSearchConsoleFixes } = await import("./sync");
const { dismissFixes, markFixesApplied, onProjectDomain, reopenFix, verifyFixes } = await import("./ops");
const { byPriority, coveredPairs, fixCounts, fixDetail, fixResultLines, fixSummary, listFixes } = await import("./queries");
const { dueResults, pageVariants, pastLastCheckpoint } = await import("./measure");
const { checkApplied, inspectLive, jobs } = await import("./jobs");

const fetched = (html: string, status = 200) => vi.mocked(safeFetch).mockResolvedValue({ url: "", status, headers: {}, body: html, truncated: false, redirects: [], ms: 1 });
const actor = { userId: "u1", source: "mcp" as const };
const finding = (code: string, url = "https://fix.example/a", detail: string | null = null) => ({ code, url, detail });

async function seed(gscProperty: string | null = null) {
  const [ws] = await db.insert(s.workspaces).values({ name: `fixes-${Date.now()}-${Math.random()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Fix site", domain: "fix.example", gscProperty }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const crawl = { id: 1, ...scope, target: "fix.example", createdAt: new Date(), startedAt: new Date() };
  const rows = () => db.select().from(s.fixes).where(eq(s.fixes.projectId, project.id));
  const one = async (code: string, url = "https://fix.example/a") => (await db.select().from(s.fixes).where(and(eq(s.fixes.projectId, project.id), eq(s.fixes.code, code), eq(s.fixes.url, url))))[0];
  return { scope, crawl, rows, one, project };
}

describe.skipIf(!ready)("syncing audit findings", () => {
  beforeEach(() => vi.mocked(safeFetch).mockReset());

  it("catches up from the latest finished audit once, and only that one", async () => {
    const { scope, rows } = await seed();
    const crawl = async (status: "done" | "running", code: string) => {
      const [c] = await db.insert(s.auditCrawls).values({ ...scope, target: "fix.example", maxPages: 10, status }).returning();
      await db.insert(s.auditIssues).values({ workspaceId: scope.workspaceId, crawlId: c.id, code, url: "https://fix.example/a", detail: "stored" });
      return c;
    };
    expect(await catchUpAuditFixes(scope)).toBeNull();

    await crawl("done", "missing-h1");
    const latest = await crawl("done", "title-too-long");
    await crawl("running", "missing-title");
    expect(await catchUpAuditFixes(scope)).toMatchObject({ found: 1 });
    expect(await rows()).toMatchObject([{ code: "title-too-long", status: "open", detail: "stored", lastSeenCrawlId: latest.id }]);

    const before = (await rows())[0].updatedAt;
    expect(await catchUpAuditFixes(scope)).toBeNull();
    expect((await rows())[0].updatedAt).toEqual(before);
  });

  it("makes one record per finding, and skips what isn't worth an agent's time", async () => {
    const { crawl, rows } = await seed();
    await syncAuditFixes(crawl, [finding("title-too-long", "https://fix.example/a", "74 characters"), finding("long-url")], ["https://fix.example/a"]);
    await syncAuditFixes(crawl, [finding("title-too-long", "https://fix.example/a", "80 characters")], ["https://fix.example/a"]);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ code: "title-too-long", status: "open", detail: "80 characters", source: "audit" });
  });

  it("makes fixes only on the project's own site and its subdomains", async () => {
    // A real crawl of one site flagged a site builder's cdn.builder.example polyfill as a broken resource: findings can name other hosts.
    const { crawl, rows } = await seed();
    const urls = ["https://fix.example/a", "https://www.fix.example/b", "https://cdn.fix.example/app.js", "https://cdn.builder.example/poly/v2/polyfill.min.js", "https://notfix.example/a", "https://fix.example.evil.test/a"];
    await syncAuditFixes(crawl, urls.map((u) => finding("broken-resources", u, "404 script")), urls);
    expect((await rows()).map((r) => r.url).sort()).toEqual(["https://cdn.fix.example/app.js", "https://fix.example/a", "https://www.fix.example/b"]);
  });

  it("clears an off-site fix an earlier sync made and nobody acted on, and leaves one someone did", async () => {
    const { scope, crawl, one } = await seed();
    const now = new Date();
    const offSite = (url: string, status: "open" | "applied") => ({ ...scope, source: "audit" as const, code: "broken-resources", url, status, firstSeenAt: now, lastSeenAt: now, updatedAt: now });
    await db.insert(s.fixes).values([offSite("https://www.ebay.com/itm/1", "open"), offSite("https://www.ebay.com/itm/2", "applied")]);
    await syncAuditFixes(crawl, [finding("broken-resources", "https://www.ebay.com/itm/1"), finding("broken-resources", "https://www.ebay.com/itm/2")], ["https://www.ebay.com/itm/1", "https://www.ebay.com/itm/2"]);
    expect(await one("broken-resources", "https://www.ebay.com/itm/1")).toBeUndefined();
    expect((await one("broken-resources", "https://www.ebay.com/itm/2")).status).toBe("applied");
  });

  it("resolves a finding only if this crawl looked at its page", async () => {
    const { crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-h1"), finding("missing-h1", "https://fix.example/b")], ["https://fix.example/a", "https://fix.example/b"]);
    await syncAuditFixes(crawl, [], ["https://fix.example/a"]);
    expect((await one("missing-h1")).status).toBe("resolved");
    expect((await one("missing-h1", "https://fix.example/b")).status).toBe("open");
  });

  it("resolves a site-wide finding whatever the crawl covered, and brings it back if it returns", async () => {
    const { crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("no-sitemap", "https://fix.example/")], []);
    await syncAuditFixes(crawl, [], []);
    expect((await one("no-sitemap", "https://fix.example/")).status).toBe("resolved");
    await syncAuditFixes(crawl, [finding("no-sitemap", "https://fix.example/")], []);
    const back = await one("no-sitemap", "https://fix.example/");
    expect(back.status).toBe("open");
    expect(back.resolvedAt).toBeNull();
  });

  it("moves an applied fix to live when the crawl stops finding it, and reopens it if a later crawl does", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-h1")], ["https://fix.example/a"]);
    fetched("<title>x</title>");
    const fix = await one("missing-h1");
    await markFixesApplied(scope, actor, { ids: [fix.id], commit: "abc123" });
    await syncAuditFixes(crawl, [], ["https://fix.example/a"]);
    const live = await one("missing-h1");
    expect(live.status).toBe("live");
    expect(live.liveCheck?.saw).toBe("The latest crawl no longer finds this.");

    // A crawl that began before it went live can't speak to it.
    await syncAuditFixes({ ...crawl, startedAt: new Date(live.liveAt!.getTime() - 60_000) }, [finding("missing-h1")], ["https://fix.example/a"]);
    expect((await one("missing-h1")).status).toBe("live");

    await syncAuditFixes({ ...crawl, startedAt: new Date(live.liveAt!.getTime() + 60_000) }, [finding("missing-h1")], ["https://fix.example/a"]);
    const reopened = await one("missing-h1");
    expect(reopened.status).toBe("open");
    expect(reopened.reopenedAt).not.toBeNull();
    expect(reopened.liveAt).toBeNull();
  });

  it("leaves an applied fix alone while it may not be deployed, and a dismissed one for good", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-h1"), finding("missing-alt")], ["https://fix.example/a"]);
    fetched("");
    await markFixesApplied(scope, actor, { ids: [(await one("missing-h1")).id] });
    await dismissFixes(scope, actor, { ids: [(await one("missing-alt")).id], reason: "Decorative" });
    await syncAuditFixes(crawl, [finding("missing-h1"), finding("missing-alt")], ["https://fix.example/a"]);
    expect((await one("missing-h1")).status).toBe("applied");
    expect(await one("missing-alt")).toMatchObject({ status: "dismissed", dismissedReason: "Decorative" });
    await syncAuditFixes(crawl, [], ["https://fix.example/a"]);
    expect((await one("missing-alt")).status).toBe("dismissed");
    await reopenFix(scope, (await one("missing-alt")).id);
    expect((await one("missing-alt")).status).toBe("open");
  });

  describe("pages with similar content", () => {
    const A = "https://fix.example/services/seo/";
    const B = "https://fix.example/services/local-seo/";
    const pair = () => [finding("duplicate-content", A, `${B} (8 of 10)`), finding("duplicate-content", B, `${A} (8 of 10)`)];
    const both = [A, B];

    it("makes one record for two pages that are each other's closest match", async () => {
      const { crawl, rows } = await seed();
      expect(await syncAuditFixes(crawl, pair(), both)).toMatchObject({ found: 1 });
      expect(await rows()).toMatchObject([{ code: "duplicate-content", status: "open" }]);
    });

    it("folds an existing second record into the first, and brings it back if the pair splits", async () => {
      const { scope, crawl, rows, one } = await seed();
      // Two records, as syncs before the fold made them.
      for (const f of pair()) await db.insert(s.fixes).values({ ...scope, source: "audit", code: f.code, url: f.url, detail: f.detail });
      const [first, second] = (await rows()).sort((x, y) => x.id - y.id);
      await syncAuditFixes(crawl, pair(), both);
      expect(await one("duplicate-content", first.url)).toMatchObject({ status: "open" });
      expect(await one("duplicate-content", second.url)).toMatchObject({ status: "resolved", evidence: { covered_by: first.url } });
      expect((await listFixes(scope, { status: ["open"] })).total).toBe(1);

      // The second page's closest match is now a third page, so it's a finding of its own again.
      await syncAuditFixes(crawl, [finding("duplicate-content", first.url, `${second.url} (8 of 10)`), finding("duplicate-content", second.url, "https://fix.example/other/ (7 of 10)")], both);
      expect(await one("duplicate-content", second.url)).toMatchObject({ status: "open", evidence: null });
    });

    it("never marks the folded record live: only the one someone applied moves on", async () => {
      const { scope, crawl, one } = await seed();
      for (const f of pair()) await db.insert(s.fixes).values({ ...scope, source: "audit", code: f.code, url: f.url, detail: f.detail });
      fetched("");
      await markFixesApplied(scope, actor, { ids: [(await one("duplicate-content", A)).id] });
      await syncAuditFixes(crawl, pair(), both);
      expect((await one("duplicate-content", A)).status).toBe("applied");
      expect(await one("duplicate-content", B)).toMatchObject({ status: "resolved", evidence: { covered_by: A } });
    });

    it("keeps the folded record out of Done and every count, and lets the kept one name it", async () => {
      const { scope, crawl, one } = await seed();
      for (const f of pair()) await db.insert(s.fixes).values({ ...scope, source: "audit", code: f.code, url: f.url, detail: f.detail });
      await syncAuditFixes(crawl, pair(), both);
      // Nothing was changed, so nothing is done.
      expect(await fixCounts(scope)).toMatchObject({ open: 1, resolved: 0 });
      expect((await listFixes(scope, { status: ["measured", "resolved"] })).total).toBe(0);
      expect((await listFixes(scope)).total).toBe(1);
      expect(await coveredPairs(scope, [A, B])).toEqual(new Map([[A, [B]]]));
      // Asked for by name, it comes back saying which record carries it.
      const covered = await listFixes(scope, { status: ["covered"] });
      expect(covered.rows.map((f) => fixSummary(f))).toMatchObject([{ url: B, status: "covered", covered_by: A }]);
      expect(fixSummary(await one("duplicate-content", A))).not.toHaveProperty("covered_by");
      // A record that went away by itself still counts as done.
      await db.insert(s.fixes).values({ ...scope, source: "audit", code: "missing-h1", url: A, status: "resolved" });
      expect(await fixCounts(scope)).toMatchObject({ resolved: 1 });
      expect((await listFixes(scope, { status: ["resolved", "covered"] })).total).toBe(2);
    });
  });

  it("keeps projects apart", async () => {
    const a = await seed();
    const b = await seed();
    await syncAuditFixes(a.crawl, [finding("missing-h1")], []);
    const fix = await a.one("missing-h1");
    expect(await verifyFixes(b.scope, [fix.id])).toEqual({ fixes: [], skipped: [{ id: fix.id, why: "There's no fix with that id in this project." }] });
    expect((await markFixesApplied(b.scope, actor, { ids: [fix.id] })).applied).toEqual([]);
    expect((await listFixes(b.scope)).total).toBe(0);
  });
});

describe.skipIf(!ready)("marking and verifying", () => {
  beforeEach(() => {
    vi.mocked(safeFetch).mockReset();
    vi.mocked(googleApis).mockReset();
  });

  it("previews without changing anything, and says why it skipped one", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-h1")], []);
    const fix = await one("missing-h1");
    const preview = await markFixesApplied(scope, actor, { ids: [fix.id, 999_999] }, { dryRun: true });
    expect(preview).toMatchObject({ applied: [fix.id], message: "Would mark 1 fix as applied." });
    expect(preview.skipped[0].why).toBe("There's no fix with that id in this project.");
    expect((await one("missing-h1")).status).toBe("open");
    await markFixesApplied(scope, actor, { ids: [fix.id] });
    expect((await markFixesApplied(scope, actor, { ids: [fix.id] })).skipped[0].why).toBe("It's already marked applied.");
  });

  it("takes the before copy from the crawl, since the live page may already show the fix", async () => {
    const { scope, crawl, one } = await seed();
    const [row] = await db.insert(s.auditCrawls).values({ ...scope, status: "done", target: "fix.example", maxPages: 10, finishedAt: new Date() }).returning();
    await db.insert(s.auditPages).values({ workspaceId: scope.workspaceId, crawlId: row.id, url: "https://fix.example/a", title: "Old title", description: "Old", wordCount: 300 });
    await syncAuditFixes(crawl, [finding("duplicate-title", "https://fix.example/a", "Old title")], []);
    const fix = await one("duplicate-title");
    fetched("<title>New title</title>");
    await markFixesApplied(scope, actor, { ids: [fix.id], commit: "abc", files: ["app/a/page.tsx"], note: "Own title" });
    const applied = await one("duplicate-title");
    expect(applied).toMatchObject({ status: "applied", appliedVia: "mcp", appliedCommit: "abc", appliedFiles: ["app/a/page.tsx"], before: { title: "Old title", from: "crawl" } });
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("falls back to the live page, then admits it has no earlier copy", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-h1"), finding("missing-alt")], []);
    fetched("<title>Live</title>");
    await markFixesApplied(scope, actor, { ids: [(await one("missing-h1")).id] });
    expect((await one("missing-h1")).before).toMatchObject({ title: "Live", from: "live" });
    vi.mocked(safeFetch).mockRejectedValue(new Error("nope"));
    await markFixesApplied(scope, actor, { ids: [(await one("missing-alt")).id] });
    expect((await one("missing-alt")).before).toMatchObject({ from: null });
  });

  it("moves an applied fix to live once the page shows it", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-h1")], []);
    const { id } = await one("missing-h1");
    fetched("");
    await markFixesApplied(scope, actor, { ids: [id] });

    const words = "word ".repeat(100);
    fetched(`<html><body><p>${words}</p></body></html>`);
    let { fixes: [v] } = await verifyFixes(scope, [id]);
    expect(v).toMatchObject({ status: "applied", live_check: { state: "still_there" }, google: null });
    expect(v.next_step).toContain("isn't on the live page");

    fetched(`<html><body><h1>New</h1><p>${words}</p></body></html>`);
    ({ fixes: [v] } = await verifyFixes(scope, [id]));
    expect(v).toMatchObject({ status: "live", live_check: { state: "fixed" } });
    expect((await one("missing-h1")).liveAt).not.toBeNull();
  });

  it("won't take a sign-in page the site redirects to for the page, before or after", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("duplicate-title", "https://fix.example/a", "Old title"), finding("missing-h1", "https://fix.example/b")], []);
    const { id } = await one("duplicate-title");
    const redirected = (url: string, html: string) => vi.mocked(safeFetch).mockResolvedValue({ url, status: 200, headers: {}, body: html, truncated: false, redirects: ["https://fix.example/a"], ms: 1 });
    const gate = "https://team.cloudflareaccess.com/cdn-cgi/access/login/fix.example";

    // With no crawl of the page, the before copy comes from the live page, and the gate isn't it.
    redirected(gate, "<title>Sign in ・ Cloudflare Access</title>");
    await markFixesApplied(scope, actor, { ids: [(await one("missing-h1", "https://fix.example/b")).id] });
    expect((await one("missing-h1", "https://fix.example/b")).before).toMatchObject({ title: null, from: null });

    fetched("<title>Old title</title>");
    await markFixesApplied(scope, actor, { ids: [id] });
    redirected(gate, "<title>Sign in ・ Cloudflare Access</title>");
    const { fixes: [v] } = await verifyFixes(scope, [id]);
    expect(v).toMatchObject({ status: "applied", live_check: { state: "cannot_check", saw: "The page redirects to team.cloudflareaccess.com, which isn't on fix.example, so SEOpen can't read it. A sign-in or access gate in front of the site does this." } });
    expect((await one("duplicate-title")).liveAt).toBeNull();

    // A redirect that stays on the site, here to www, is still the page.
    redirected("https://www.fix.example/a", "<title>A title of its own</title>");
    expect((await verifyFixes(scope, [id])).fixes[0]).toMatchObject({ status: "live", live_check: { state: "fixed" } });
  });

  it("reports Google's view, stores the inspection, and tells the owner to request indexing", async () => {
    const { scope, crawl, one, project } = await seed("sc-domain:fix.example");
    await syncAuditFixes(crawl, [finding("missing-title")], []);
    const { id } = await one("missing-title");
    fetched("");
    await markFixesApplied(scope, actor, { ids: [id] });
    fetched("<title>New title for this page</title>");
    const inspect = vi.fn().mockResolvedValue({ verdict: "PASS", coverageState: "Submitted and indexed", lastCrawlTime: "2020-01-01T00:00:00Z", inspectionResultLink: "https://search.google.com/x" });
    vi.mocked(googleApis).mockResolvedValue({ gsc: { inspect } } as never);
    const { fixes: [v] } = await verifyFixes(scope, [id]);
    expect(inspect).toHaveBeenCalledWith("sc-domain:fix.example", "https://fix.example/a");
    expect(v.google).toMatchObject({ verdict: "PASS", recrawled_since_fix: false, inspection_link: "https://search.google.com/x" });
    expect(v.next_step).toContain("Request Indexing");
    const stored = await db.select().from(s.gscUrlInspections).where(eq(s.gscUrlInspections.projectId, project.id));
    expect(stored).toHaveLength(1);

    inspect.mockResolvedValue({ verdict: "PASS", lastCrawlTime: new Date(Date.now() + 60_000).toISOString(), inspectionResultLink: "https://search.google.com/x" });
    const { fixes: [again] } = await verifyFixes(scope, [id]);
    expect(again.google?.recrawled_since_fix).toBe(true);
    expect((await one("missing-title")).recrawledAt).not.toBeNull();
  });

  it("carries on when Google can't answer", async () => {
    const { scope, crawl, one } = await seed("sc-domain:fix.example");
    await syncAuditFixes(crawl, [finding("missing-title")], []);
    const { id } = await one("missing-title");
    fetched("");
    await markFixesApplied(scope, actor, { ids: [id] });
    fetched("<title>New title for this page</title>");
    vi.mocked(googleApis).mockRejectedValue(new Error("no account"));
    const { fixes: [v] } = await verifyFixes(scope, [id]);
    expect(v.status).toBe("live");
    expect(v.google?.note).toBe("Search Console didn't answer.");
  });

  it("won't fetch an address off the project's domain", async () => {
    // The sync no longer makes such a record, but one from before it stopped can still be on the list.
    const { scope, one } = await seed();
    const now = new Date();
    await db.insert(s.fixes).values({ ...scope, source: "audit", code: "broken-resources", url: "https://cdn.other.example/logo.png", firstSeenAt: now, lastSeenAt: now, updatedAt: now });
    const { id } = await one("broken-resources", "https://cdn.other.example/logo.png");
    const { fixes: [v] } = await verifyFixes(scope, [id]);
    expect(v.live_check.state).toBe("cannot_check");
    expect(safeFetch).not.toHaveBeenCalled();
    expect(onProjectDomain("https://www.fix.example/a", "fix.example")).toBe(true);
    expect(onProjectDomain("https://blog.fix.example/a", "www.fix.example")).toBe(true);
    expect(onProjectDomain("https://notfix.example/a", "fix.example")).toBe(false);
  });

  it("checks an open fix without marking it, and refuses too many at once", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-title")], []);
    const { id } = await one("missing-title");
    fetched("<title>Already fine, thank you very much</title>");
    const { fixes: [v] } = await verifyFixes(scope, [id]);
    expect(v).toMatchObject({ status: "open", live_check: { state: "fixed" } });
    expect(v.next_step).toContain("mark_fix_applied");
    expect((await one("missing-title")).status).toBe("open");
    await expect(verifyFixes(scope, Array.from({ length: 21 }, (_, i) => i + 1))).rejects.toThrow("one call can take 20");
  });

  it("answers in the order asked, and skips an id it doesn't know", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-title"), finding("missing-h1")], []);
    const title = await one("missing-title");
    const h1 = await one("missing-h1");
    fetched("<title>Already fine, thank you very much</title>");
    const res = await verifyFixes(scope, [h1.id, 99_999_999, title.id]);
    expect(res.fixes.map((f) => f.id)).toEqual([h1.id, title.id]);
    expect(res.skipped).toEqual([{ id: 99_999_999, why: "There's no fix with that id in this project." }]);
  });
});

describe.skipIf(!ready)("measuring", () => {
  const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;

  async function withTraffic(scope: { workspaceId: number; projectId: number }, page: string) {
    // 14 days before and 14 after Oct 15: the page's clicks rise from 2 a day to 3, and the site's stay level.
    for (let d = 1; d <= 29; d++) {
      const clicks = d < 15 ? 2 : d > 15 ? 3 : 0;
      await db.insert(s.gscPages).values({ ...scope, date: day(d), page, clicks, impressions: clicks * 10, ctr: 0.1, position: 5 });
      await db.insert(s.gscDaily).values({ ...scope, date: day(d), clicks: 100, impressions: 1000, ctr: 0.1, position: 5 });
    }
  }

  it("matches every address a page can be reported under", () => {
    const v = pageVariants("https://www.x.com/a/");
    for (const url of ["https://x.com/a", "https://www.x.com/a", "http://x.com/a/", "http://www.x.com/a"]) expect(v).toContain(url);
    expect(pageVariants("https://x.com/")).toContain("https://www.x.com/");
  });

  it("compares the days after with the days before, beside the site, once they've all arrived", async () => {
    const { scope, crawl, one } = await seed("sc-domain:fix.example");
    await withTraffic(scope, "https://www.fix.example/a/");
    await syncAuditFixes(crawl, [finding("missing-title")], []);
    const fix = { ...(await one("missing-title")), liveAt: new Date("2026-10-15T20:00:00Z"), status: "live" };

    const early = await dueResults(scope, fix, { first: day(1), last: day(21) });
    expect(Object.keys(early)).toEqual([]);

    const due = await dueResults(scope, fix, { first: day(1), last: day(29) });
    expect(Object.keys(due).sort()).toEqual(["14", "7"]);
    expect(due["14"]).toMatchObject({ days: 14, before: { from: "2026-10-01", to: "2026-10-14", clicks: 28 }, after: { from: "2026-10-16", to: "2026-10-29", clicks: 42 } });
    expect(due["14"].site.after.clicks).toBe(1400);
    expect(pastLastCheckpoint(fix, { last: day(29) })).toBe(false);
    expect(pastLastCheckpoint(fix, { last: "2026-11-12" })).toBe(true);
  });

  it("leaves rank checkers' searches out, as the Search Console page does", async () => {
    const { scope, crawl, one } = await seed("sc-domain:fix.example");
    await withTraffic(scope, "https://fix.example/a");
    // After the fix, another tool's numbered rank checks add 1 click and 200 impressions a day at position 1, to the page and the site.
    for (let d = 16; d <= 29; d++) {
      const bot = { ...scope, date: day(d), query: "5196: daily keyword rank tracking", clicks: 1, impressions: 200, ctr: 0.005, position: 1 };
      await db.insert(s.gscQueries).values(bot);
      await db.insert(s.gscQueryPages).values({ ...bot, page: "https://fix.example/a" });
      // A person's search with a short number stays in.
      await db.insert(s.gscQueryPages).values({ ...scope, date: day(d), query: "404: page not found meaning", page: "https://fix.example/a", clicks: 0, impressions: 5, ctr: 0, position: 9 });
    }
    for (let d = 16; d <= 29; d++) {
      await db.update(s.gscPages).set({ clicks: 4, impressions: 230 }).where(and(eq(s.gscPages.projectId, scope.projectId), eq(s.gscPages.date, day(d))));
      await db.update(s.gscDaily).set({ clicks: 101, impressions: 1200 }).where(and(eq(s.gscDaily.projectId, scope.projectId), eq(s.gscDaily.date, day(d))));
    }
    await syncAuditFixes(crawl, [finding("missing-title")], []);
    const fix = { ...(await one("missing-title")), liveAt: new Date("2026-10-15T20:00:00Z") };
    const due = await dueResults(scope, fix, { first: day(1), last: day(29) });
    expect(due["14"].after).toMatchObject({ clicks: 42, impressions: 420 });
    expect(due["14"].site.after).toMatchObject({ clicks: 1400, impressions: 14_000 });
    // Stored: 230 a day at 5 holds 200 at 1, so the rest average (230 × 5 − 200) / 30.
    expect(due["14"].after.position).toBeCloseTo((230 * 5 - 200) / 30);
    expect(due["14"].site.after.position).toBeCloseTo((1200 * 5 - 200) / 1000);
  });

  it("won't compare with days it has no data for", async () => {
    const { scope, crawl, one } = await seed("sc-domain:fix.example");
    await withTraffic(scope, "https://fix.example/a");
    await syncAuditFixes(crawl, [finding("missing-title")], []);
    const fix = { ...(await one("missing-title")), liveAt: new Date("2026-10-15T20:00:00Z") };
    expect(Object.keys(await dueResults(scope, fix, { first: day(5), last: day(29) }))).toEqual(["7"]);
  });

  it("reads a site-wide fix from the site's numbers, and writes the line", async () => {
    const { scope, crawl, one } = await seed("sc-domain:fix.example");
    await withTraffic(scope, "https://fix.example/a");
    await syncAuditFixes(crawl, [finding("no-sitemap", "https://fix.example/")], []);
    const fix = await one("no-sitemap", "https://fix.example/");
    const liveAt = new Date("2026-10-15T20:00:00Z");
    const results = await dueResults(scope, { ...fix, liveAt }, { first: day(1), last: day(29) });
    expect(results["14"].before.clicks).toBe(1400);
    await db.update(s.fixes).set({ status: "live", liveAt, results }).where(eq(s.fixes.id, fix.id));
    const [line] = await fixResultLines(scope);
    expect(line.sentence).toBe("Fixed 1 sitemap on Oct 15. Clicks held about level in 14 days, at 1,400. No clear change yet.");
  });
});

describe.skipIf(!ready)("Search Console findings", () => {
  async function traffic(scope: { workspaceId: number; projectId: number }) {
    const row = (date: string, page: string, clicks: number, impressions: number, position: number) => ({ ...scope, date, page, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
    await db.insert(s.gscDaily).values([{ ...scope, date: "2026-09-01", clicks: 0, impressions: 0, ctr: 0, position: 0 }, { ...scope, date: "2026-10-28", clicks: 10, impressions: 1000, ctr: 0.01, position: 4 }]);
    await db.insert(s.gscPages).values([row("2026-10-20", "https://fix.example/low", 2, 1000, 4), row("2026-09-20", "https://fix.example/falling", 50, 500, 5), row("2026-10-20", "https://fix.example/falling", 5, 400, 7)]);
    await db.insert(s.gscQueries).values({ ...scope, date: "2026-10-20", query: "close search", clicks: 1, impressions: 300, ctr: 0.003, position: 12 });
    await db.insert(s.gscQueryPages).values({ ...scope, date: "2026-10-20", query: "close search", page: "https://fix.example/close", clicks: 1, impressions: 300, ctr: 0.003, position: 12 });
    await db.insert(s.indexingPages).values({ ...scope, url: "https://fix.example/out", inspectedAt: new Date(), verdict: "NEUTRAL", coverageState: "Excluded by 'noindex' tag" });
  }

  it("turns the numbers into records, and they go away with the problem", async () => {
    const { scope, one, rows } = await seed("sc-domain:fix.example");
    await traffic(scope);
    await syncSearchConsoleFixes(scope);
    const low = await one("gsc-low-ctr", "https://fix.example/low");
    expect(low).toMatchObject({ source: "search_console", status: "open", pageImpressions: 1000 });
    expect(low.evidence).toMatchObject({ impressions: 1000, clicks: 2 });
    expect(await one("gsc-losing-clicks", "https://fix.example/falling")).toMatchObject({ status: "open", evidence: { clicks: 5, previous_clicks: 50 } });
    expect((await one("gsc-striking-distance", "https://fix.example/close")).evidence).toMatchObject({ queries: [{ query: "close search", position: 12, impressions: 300 }], searches_in_range: 1, impressions: 300, score: 158.8, period: { start: "2026-10-01", end: "2026-10-28" } });
    expect((await one("gsc-not-indexed", "https://fix.example/out")).evidence).toMatchObject({ coverage: "Excluded by 'noindex' tag", status: "blocked" });

    await db.delete(s.gscPages).where(eq(s.gscPages.page, "https://fix.example/low"));
    await syncSearchConsoleFixes(scope);
    expect((await one("gsc-low-ctr", "https://fix.example/low")).status).toBe("resolved");
    // /falling is low on clicks for its position too, so it has both findings.
    expect((await rows()).filter((f) => f.status === "open").length).toBe(4);
  });

  it("raises not-indexed fixes from the sitemap's pages only, for causes on the site, and drops them once Google indexes the page", async () => {
    const { scope, one } = await seed("sc-domain:fix.example");
    await traffic(scope);
    const now = new Date();
    const page = (url: string, verdict: string, coverageState: string) => ({ ...scope, url, inspectedAt: now, verdict, coverageState });
    await db.insert(s.indexingPages).values([
      page("https://fix.example/waiting", "NEUTRAL", "URL is unknown to Google"),
      page("https://fix.example/crawled", "NEUTRAL", "Crawled - currently not indexed"),
      page("https://fix.example/alternate", "NEUTRAL", "Alternate page with proper canonical tag"),
      page("https://fix.example/copy", "NEUTRAL", "Duplicate, Google chose different canonical than user"),
      { ...scope, url: "https://fix.example/unchecked" },
    ]);
    // A one-off inspection of a URL outside the sitemap stays in the history and makes no fix.
    await db.insert(s.gscUrlInspections).values({ ...scope, url: "https://fix.example/does-not-exist", verdict: "NEUTRAL", coverageState: "Excluded by 'noindex' tag" });
    await syncSearchConsoleFixes(scope);
    for (const url of ["waiting", "crawled", "alternate", "unchecked", "does-not-exist"]) expect(await one("gsc-not-indexed", `https://fix.example/${url}`)).toBeUndefined();
    expect(await one("gsc-not-indexed", "https://fix.example/copy")).toMatchObject({ status: "open", evidence: { status: "duplicate" } });
    expect(await one("gsc-not-indexed", "https://fix.example/out")).toMatchObject({ status: "open" });

    // Google indexes /out, by an inspection asked for on its own: the sitemap row follows it, and the fix goes.
    const { saveInspection } = await import("@/modules/indexing/inspection");
    const pass = { verdict: "PASS", coverageState: "Submitted and indexed", indexingState: "INDEXING_ALLOWED", robotsTxtState: "ALLOWED", pageFetchState: "SUCCESSFUL", lastCrawlTime: now.toISOString(), googleCanonical: null, userCanonical: null, crawledAs: null, inspectionResultLink: "https://search.google.com/x", richResults: null };
    await saveInspection(scope, "https://fix.example/out", pass);
    const [row] = await db.select().from(s.indexingPages).where(and(eq(s.indexingPages.projectId, scope.projectId), eq(s.indexingPages.url, "https://fix.example/out")));
    expect(row).toMatchObject({ verdict: "PASS", coverageState: "Submitted and indexed", inspectionLink: "https://search.google.com/x" });
    expect(row.indexedAt).not.toBeNull();
    await saveInspection(scope, "https://fix.example/elsewhere", pass);
    expect(await db.$count(s.indexingPages, and(eq(s.indexingPages.projectId, scope.projectId), eq(s.indexingPages.url, "https://fix.example/elsewhere")))).toBe(0);
    expect(await db.$count(s.gscUrlInspections, and(eq(s.gscUrlInspections.projectId, scope.projectId), eq(s.gscUrlInspections.url, "https://fix.example/elsewhere")))).toBe(1);

    await syncSearchConsoleFixes(scope);
    expect((await one("gsc-not-indexed", "https://fix.example/out")).status).toBe("resolved");
  });

  it("keeps audit records and logged changes at the page's latest 28 days", async () => {
    const { scope, crawl, one } = await seed("sc-domain:fix.example");
    await syncAuditFixes(crawl, [finding("missing-h1", "https://fix.example/low/")], []);
    const now = new Date();
    await db.insert(s.fixes).values({ ...scope, source: "manual", code: "manual-change", url: "https://www.fix.example/low", status: "live", pageImpressions: 0, firstSeenAt: now, lastSeenAt: now, updatedAt: now });
    await db.insert(s.fixes).values({ ...scope, source: "audit", code: "missing-title", url: "https://fix.example/gone", pageImpressions: 7, firstSeenAt: now, lastSeenAt: now, updatedAt: now });
    expect(await refreshPageImpressions(scope)).toEqual({ updated: 0 });
    expect((await one("missing-h1", "https://fix.example/low/")).pageImpressions).toBe(0);

    await traffic(scope);
    expect(await refreshPageImpressions(scope)).toEqual({ updated: 3 });
    expect((await one("missing-h1", "https://fix.example/low/")).pageImpressions).toBe(1000);
    expect((await one("manual-change", "https://www.fix.example/low")).pageImpressions).toBe(1000);
    expect((await one("missing-title", "https://fix.example/gone")).pageImpressions).toBe(0);
    expect(await refreshPageImpressions(scope)).toEqual({ updated: 0 });
  });

  it("holds Search Console fixes on a page whose logged change is being measured, and brings them back after", async () => {
    const { scope, one } = await seed("sc-domain:fix.example");
    await traffic(scope);
    const now = new Date();
    const [change] = await db.insert(s.fixes).values({ ...scope, source: "manual", code: "manual-change", url: "https://www.fix.example/low/", status: "applied", appliedAt: now, firstSeenAt: now, lastSeenAt: now, updatedAt: now }).returning();
    await syncSearchConsoleFixes(scope);
    expect(await one("gsc-low-ctr", "https://fix.example/low")).toBeUndefined();
    expect(await one("gsc-low-ctr", "https://fix.example/falling")).toMatchObject({ status: "open" });

    // A record opened before the change was logged is covered by it.
    await db.update(s.fixes).set({ status: "measured" }).where(eq(s.fixes.id, change.id));
    await syncSearchConsoleFixes(scope);
    const { id } = await one("gsc-low-ctr", "https://fix.example/low");
    await db.update(s.fixes).set({ status: "live", liveAt: now }).where(eq(s.fixes.id, change.id));
    await syncSearchConsoleFixes(scope);
    expect(await one("gsc-low-ctr", "https://fix.example/low")).toMatchObject({ status: "resolved", evidence: { impressions: 1000, covered_by: "https://www.fix.example/low/" } });
    expect((await listFixes(scope)).rows.map((f) => f.id)).not.toContain(id);
    expect((await listFixes(scope, { status: ["covered"] })).rows.map((f) => fixSummary(f))).toMatchObject([{ id, status: "covered", covered_by: "https://www.fix.example/low/" }]);

    // Once the change's result is in, the page is flagged again as it stands.
    await db.update(s.fixes).set({ status: "measured" }).where(eq(s.fixes.id, change.id));
    await syncSearchConsoleFixes(scope);
    const back = await one("gsc-low-ctr", "https://fix.example/low");
    expect(back).toMatchObject({ id, status: "open" });
    expect(back.evidence).not.toHaveProperty("covered_by");

    // Covered, then no longer flagged once the page is free: it goes like any other.
    await db.update(s.fixes).set({ status: "live" }).where(eq(s.fixes.id, change.id));
    await syncSearchConsoleFixes(scope);
    await db.delete(s.gscPages).where(eq(s.gscPages.page, "https://fix.example/low"));
    await db.update(s.fixes).set({ status: "measured" }).where(eq(s.fixes.id, change.id));
    await syncSearchConsoleFixes(scope);
    const gone = await one("gsc-low-ctr", "https://fix.example/low");
    expect(gone.status).toBe("resolved");
    expect(gone.evidence).not.toHaveProperty("covered_by");
  });

  it("doesn't reopen a live fix on old numbers, only once its result is in", async () => {
    const { scope, one } = await seed("sc-domain:fix.example");
    await traffic(scope);
    await syncSearchConsoleFixes(scope);
    const { id } = await one("gsc-low-ctr", "https://fix.example/low");
    await db.update(s.fixes).set({ status: "live", liveAt: new Date() }).where(eq(s.fixes.id, id));
    await syncSearchConsoleFixes(scope);
    expect((await one("gsc-low-ctr", "https://fix.example/low")).status).toBe("live");
    await db.update(s.fixes).set({ status: "measured" }).where(eq(s.fixes.id, id));
    await syncSearchConsoleFixes(scope);
    expect((await one("gsc-low-ctr", "https://fix.example/low")).status).toBe("open");
  });

  it("finds one search on two pages, and a page shown often far down, with the searches behind them", async () => {
    const { scope, one, rows } = await seed("sc-domain:fix.example");
    const pair = (query: string, page: string, impressions: number, position: number) => ({ ...scope, date: "2026-10-20", query, page, clicks: 0, impressions, ctr: 0, position });
    const page = (url: string, impressions: number, position: number) => ({ ...scope, date: "2026-10-20", page: url, clicks: 1, impressions, ctr: 1 / impressions, position });
    await db.insert(s.gscDaily).values({ ...scope, date: "2026-10-28", clicks: 5, impressions: 3_000, ctr: 0, position: 40 });
    await db.insert(s.gscPages).values([page("https://fix.example/tools/ai", 70, 12), page("https://fix.example/features/ai", 10, 40), page("https://fix.example/features/backlinks", 1_954, 86.5)]);
    await db.insert(s.gscQueryPages).values([
      pair("ai overview checker", "https://fix.example/tools/ai", 70, 12),
      pair("ai overview checker", "https://fix.example/features/ai", 10, 40),
      pair("backlink checker", "https://fix.example/features/backlinks", 900, 88),
      pair("free backlink checker", "https://fix.example/features/backlinks", 500, 85),
    ]);
    await syncSearchConsoleFixes(scope);

    const split = await one("gsc-split-query", "https://fix.example/features/ai");
    expect(split).toMatchObject({ source: "search_console", status: "open", pageImpressions: 10 });
    expect(split.evidence).toEqual({
      queries: [{ query: "ai overview checker", impressions: 80, pages: [{ page: "https://fix.example/tools/ai", impressions: 70, clicks: 0, position: 12 }, { page: "https://fix.example/features/ai", impressions: 10, clicks: 0, position: 40 }] }],
      searches_split: 1,
      impressions: 10,
      period: { start: "2026-10-01", end: "2026-10-28" },
    });
    const far = await one("gsc-shown-not-ranking", "https://fix.example/features/backlinks");
    expect(far).toMatchObject({ status: "open", pageImpressions: 1_954 });
    expect(far.evidence).toEqual({ impressions: 1_954, clicks: 1, position: 86.5, queries: [{ query: "backlink checker", impressions: 900, position: 88 }, { query: "free backlink checker", impressions: 500, position: 85 }], period: { start: "2026-10-01", end: "2026-10-28" } });
    // The page with more of the search carries no split record (it's close to page one, which is its own finding), and /features/ai isn't shown often enough.
    expect((await rows()).map((f) => `${f.code} ${f.url}`).sort()).toEqual(["gsc-shown-not-ranking https://fix.example/features/backlinks", "gsc-split-query https://fix.example/features/ai", "gsc-striking-distance https://fix.example/tools/ai"]);

    await db.delete(s.gscQueryPages).where(and(eq(s.gscQueryPages.projectId, scope.projectId), eq(s.gscQueryPages.page, "https://fix.example/features/ai")));
    await syncSearchConsoleFixes(scope);
    expect((await one("gsc-split-query", "https://fix.example/features/ai")).status).toBe("resolved");
  });

  it("finds a search Google answers with a different kind of page, from saved results only", async () => {
    const { workspaceCacheKey } = await import("@/lib/dataforseo/client");
    const { serpSpec } = await import("@/modules/keywords/requests");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { scope, one, rows } = await seed("sc-domain:fix.example");
    // The response cache is shared and outlives a run, so the saved lookup's search is this run's own.
    const looked = `link checker ${Date.now()} ${Math.random()}`;
    const pair = (query: string, page: string, impressions: number, position: number) => ({ ...scope, date: "2026-10-20", query, page, clicks: 0, impressions, ctr: 0, position });
    await db.insert(s.gscDaily).values({ ...scope, date: "2026-10-28", clicks: 5, impressions: 3_000, ctr: 0, position: 40 });
    await db.insert(s.gscQueryPages).values([
      pair(looked, "https://fix.example/blog/check-links", 300, 71),
      pair("site audit tool", "https://fix.example/blog/audits", 250, 64),
      pair("backlink checker", "https://fix.example/features/backlinks", 900, 88),
      pair("widget ideas", "https://fix.example/blog/widgets", 200, 40),
      pair("tiny search", "https://fix.example/blog/tiny", 20, 50),
    ]);
    const [crawl] = await db.insert(s.auditCrawls).values({ ...scope, target: "fix.example", maxPages: 10, status: "done", finishedAt: new Date() }).returning();
    await db.insert(s.auditPages).values([
      { workspaceId: scope.workspaceId, crawlId: crawl.id, url: "https://fix.example/blog/check-links", title: "How to check your links" },
      { workspaceId: scope.workspaceId, crawlId: crawl.id, url: "https://fix.example/blog/audits", title: "How a site audit works" },
      // As titled on main (src/content/pages.ts): a feature page whose title names a tool.
      { workspaceId: scope.workspaceId, crawlId: crawl.id, url: "https://fix.example/features/backlinks", title: "Backlink checker and explorer: who links to you" },
      { workspaceId: scope.workspaceId, crawlId: crawl.id, url: "https://fix.example/blog/widgets", title: "How to pick widgets" },
    ]);
    const item = (i: number, title: string, url: string) => ({ type: "organic", pos: i, abs: i, domain: new URL(url).hostname, url, title });
    const tools = (n: number) => [...Array.from({ length: n }, (_, i) => item(i + 1, "Free Site Audit Checker", `https://tool${i}.example/audit`)), ...Array.from({ length: 10 - n }, (_, i) => item(n + i + 1, "How audits work", `https://read${i}.example/blog/audits`))];
    const tracked = async (keyword: string, top: ReturnType<typeof item>[]) => {
      const [k] = await db.insert(s.rankKeywords).values({ ...scope, keyword }).returning();
      await db.insert(s.rankResults).values({ ...scope, keywordId: k.id, date: "2026-10-27", depth: 10, checkedAt: new Date("2026-10-27T06:00:00Z"), top });
    };
    await tracked("site audit tool", tools(8));
    await tracked("backlink checker", tools(8));
    // Only 5 of 10 share a type, so Google hasn't settled.
    await tracked("widget ideas", [...tools(5).slice(0, 5), ...Array.from({ length: 5 }, (_, i) => item(6 + i, "Acme", `https://acme${i}.example/widgets`))]);
    await tracked("tiny search", tools(8));
    const spec = serpSpec(looked, { locationCode: 2840, languageCode: "en" });
    const key = workspaceCacheKey(scope.workspaceId, "POST", spec.path, [spec.task]);
    const organic = (i: number, title: string, url: string) => ({ type: "organic", rank_group: i, rank_absolute: i, domain: new URL(url).hostname, url, title });
    const response = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ keyword: looked, items: [...Array.from({ length: 7 }, (_, i) => organic(i + 1, "Free Link Checker", `https://tool${i}.example/check`)), organic(8, "How links work", "https://read.example/blog/links"), organic(9, "Links explained", "https://learn.example/guides/links"), organic(10, "Acme", "https://acme.example/links")] }] }] };
    await db.insert(s.apiCache).values({ key, endpoint: spec.path, response, expiresAt: new Date(Date.now() + 86_400_000) }).onConflictDoUpdate({ target: s.apiCache.key, set: { response, expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date() } });
    await db.insert(s.apiCacheAccess).values({ key, workspaceId: scope.workspaceId });

    await syncSearchConsoleFixes(scope);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    const fromLookup = await one("gsc-wrong-page-type", "https://fix.example/blog/check-links");
    expect(fromLookup).toMatchObject({ source: "search_console", status: "open", pageImpressions: 300 });
    expect(fromLookup.evidence).toMatchObject({
      query: looked,
      impressions: 300,
      position: 71,
      period: { start: "2026-10-01", end: "2026-10-28" },
      dominant_type: "tool",
      agree: 7,
      of: 10,
      top_urls: ["https://tool0.example/check", "https://tool1.example/check", "https://tool2.example/check"],
      serp_from: "a saved results lookup",
      page_type: "guide",
      page_type_why: "title or address reads as an article: its title “How to check your links” (from SEOpen's latest site audit) and its address agree",
      page_title: "How to check your links",
      searches_mismatched: 1,
      other_searches: [],
    });
    expect((await one("gsc-wrong-page-type", "https://fix.example/blog/audits")).evidence).toMatchObject({ query: "site audit tool", dominant_type: "tool", agree: 8, serp_from: "the daily rank check", serp_checked_at: "2026-10-27T06:00:00.000Z", page_type: "guide" });
    // The feature page reads as a tool from its title only, a mixed top 10 has no dominant type, and a sliver of a search doesn't count.
    expect((await rows()).filter((f) => f.code === "gsc-wrong-page-type").map((f) => f.url).sort()).toEqual(["https://fix.example/blog/audits", "https://fix.example/blog/check-links"]);

    // A paid lookup is saved for a day: once it expires, the record keeps the results it was raised on.
    await db.delete(s.apiCacheAccess).where(and(eq(s.apiCacheAccess.key, key), eq(s.apiCacheAccess.workspaceId, scope.workspaceId)));
    await syncSearchConsoleFixes(scope);
    expect(await one("gsc-wrong-page-type", "https://fix.example/blog/check-links")).toMatchObject({ status: "open", evidence: { query: looked, dominant_type: "tool", serp_from: "a saved results lookup" } });
    // Once Search Console no longer ties the page to the search, it goes.
    await db.delete(s.gscQueryPages).where(and(eq(s.gscQueryPages.projectId, scope.projectId), eq(s.gscQueryPages.page, "https://fix.example/blog/check-links")));
    await syncSearchConsoleFixes(scope);
    expect((await one("gsc-wrong-page-type", "https://fix.example/blog/check-links")).status).toBe("resolved");
  });

  it("does nothing without data", async () => {
    const { scope, rows } = await seed("sc-domain:fix.example");
    expect(await syncSearchConsoleFixes(scope)).toEqual({ found: 0, gone: 0 });
    expect(await rows()).toEqual([]);
  });
});

describe.skipIf(!ready)("reading fixes", () => {
  it("lists errors first, then the pages people see, and filters", async () => {
    const { scope, crawl } = await seed();
    await syncAuditFixes(crawl, [finding("missing-alt"), finding("missing-title", "https://fix.example/b"), finding("slow-server-response", "https://fix.example/c")], []);
    const list = await listFixes(scope);
    expect(list.total).toBe(3);
    expect(list.rows[0].code).toBe("missing-title");
    expect((await listFixes(scope, { kind: "hosting" })).rows.map((f) => f.code)).toEqual(["slow-server-response"]);
    expect((await listFixes(scope, { code: "missing-alt" })).total).toBe(1);
    expect((await listFixes(scope, { urlContains: "/b" })).total).toBe(1);
    expect((await fixCounts(scope)).open).toBe(3);
    expect(byPriority({ code: "missing-alt", pageImpressions: 10 }, { code: "missing-alt", pageImpressions: 20 })).toBeGreaterThan(0);
  });

  it("gives an agent the page, the searches and the files, and holds reports back from Free", async () => {
    const { scope, crawl, one } = await seed();
    const [row] = await db.insert(s.auditCrawls).values({ ...scope, status: "done", target: "fix.example", maxPages: 10, finishedAt: new Date() }).returning();
    await db.insert(s.auditPages).values({ workspaceId: scope.workspaceId, crawlId: row.id, url: "https://fix.example/a", title: "Now", description: "Desc", wordCount: 300 });
    await db.insert(s.gscDaily).values({ ...scope, date: "2026-10-20", clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
    await db.insert(s.gscQueryPages).values({ ...scope, date: "2026-10-20", query: "best thing", page: "https://fix.example/a", clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
    await syncAuditFixes(crawl, [finding("title-too-long", "https://fix.example/a", "74 characters")], []);
    const fix = await one("title-too-long");
    const detail = await fixDetail(scope, fix, { showResults: true });
    expect(detail).toMatchObject({ code: "title-too-long", kind: "code", can_agent_fix: true, page_now: { title: "Now", words: 300 }, search_console: { top_queries: [{ query: "best thing" }] } });
    expect(detail.likely_files.nextjs[0]).toBe("app/a/page.tsx");
    expect(detail.results).toEqual([]);
    const free = await fixDetail(scope, fix, { showResults: false });
    expect(free.results).toBeUndefined();
    expect(free.results_note).toContain("Starter");
    expect(detail.page_now).not.toHaveProperty("note");
  });

  it("says when the crawl behind page_now is older than the live check that found the change", async () => {
    const { scope, crawl, one } = await seed();
    const crawled = new Date("2026-11-16T04:32:00Z");
    const [row] = await db.insert(s.auditCrawls).values({ ...scope, status: "done", target: "fix.example", maxPages: 10, finishedAt: crawled }).returning();
    await db.insert(s.auditPages).values({ workspaceId: scope.workspaceId, crawlId: row.id, url: "https://fix.example/a", title: "Old title", wordCount: 300 });
    await syncAuditFixes(crawl, [finding("title-too-long", "https://fix.example/a", "74 characters")], []);
    const fix = await one("title-too-long");
    const seen = (liveCheck: NonNullable<typeof fix.liveCheck>) => fixDetail(scope, { ...fix, status: "live", liveCheck }, { showResults: false });

    const live = await seen({ state: "fixed", saw: "The title is 40 characters now.", checkedAt: "2026-11-16T18:00:00.000Z", status: 200 });
    expect(live.page_now).toMatchObject({ title: "Old title", note: "This is the page as the site audit on 2026-11-16 saw it. The live check on 2026-11-16 found the change, so the live page differs. The next site audit brings this up to date." });
    // A crawl that confirmed the fix is the page now, and a check from before the crawl is older than it.
    expect((await seen({ state: "fixed", saw: "The latest crawl no longer finds this.", checkedAt: "2026-11-16T18:00:00.000Z", status: null })).page_now).not.toHaveProperty("note");
    expect((await seen({ state: "fixed", saw: "The title is 40 characters now.", checkedAt: "2026-11-15T18:00:00.000Z", status: 200 })).page_now).not.toHaveProperty("note");
  });
});

describe.skipIf(!ready)("the daily job", () => {
  it("fans out, then checks an applied fix without using the network for a project with none", async () => {
    const { scope, crawl, one } = await seed();
    await syncAuditFixes(crawl, [finding("missing-title")], []);
    const { id } = await one("missing-title");
    vi.mocked(safeFetch).mockReset();
    fetched("");
    await markFixesApplied(scope, actor, { ids: [id] });
    fetched("<title>Long enough title for the page now</title>");
    const job = jobs.find((j) => j.name === "fixes.daily")!;
    const out = await (job.handler as (p: unknown) => Promise<Record<string, unknown>>)(scope);
    expect(out).toMatchObject({ checked: 1, live: 1 });
    expect((await one("missing-title")).status).toBe("live");
  });
});

describe.skipIf(!ready)("the daily job's share of checks", () => {
  /** Fixes on `urls`, all in `status`, as if applied and live a day ago. */
  async function many(status: "applied" | "live", urls: string[], code = "missing-title") {
    const { scope, project, rows } = await seed("https://fix.example/");
    const day = new Date(Date.now() - 86_400_000);
    // Applied a millisecond apart, so the order they were applied in is fixed.
    await db.insert(s.fixes).values(urls.map((url, i) => ({ ...scope, source: "audit", code, url, status, appliedAt: new Date(day.getTime() + i), liveAt: status === "live" ? day : null })));
    return { scope, project: { ...project }, rows };
  }

  it("inspects the pages it can, though more it can't inspect went live first", async () => {
    // 25 pages outside the Search Console property, never inspected, and 3 inside it, inspected two days ago.
    const outside = Array.from({ length: 25 }, (_, i) => `https://shop.fix.example/${i}`);
    const inside = ["https://fix.example/a", "https://fix.example/b", "https://fix.example/c"];
    const { scope, project, rows } = await many("live", outside);
    const day = new Date(Date.now() - 86_400_000 + 1000);
    const twoDays = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(s.fixes).values(inside.map((url) => ({ ...scope, source: "audit", code: "missing-title", url, status: "live", appliedAt: day, liveAt: day, inspectedAt: twoDays })));
    const inspect = vi.fn().mockResolvedValue({ verdict: "PASS", lastCrawlTime: null });
    vi.mocked(googleApis).mockResolvedValue({ gsc: { inspect } } as never);

    expect(await inspectLive(scope, project, new Date())).toEqual({ inspected: 3 });
    expect(inspect.mock.calls.map(([, url]) => url).sort()).toEqual(inside);
    expect((await rows()).filter((f) => f.inspectedAt).length).toBe(3);
  });

  it("moves past a page whose inspection fails, and reaches the others", async () => {
    const urls = Array.from({ length: 22 }, (_, i) => `https://fix.example/p${String(i).padStart(2, "0")}`);
    const { scope, project } = await many("live", urls);
    const inspect = vi.fn(async (_p: string, url: string) => {
      if (url.endsWith("p00")) throw Object.assign(new Error("Quota exceeded for this URL"), { status: 429 });
      return { verdict: "PASS", lastCrawlTime: null };
    });
    vi.mocked(googleApis).mockResolvedValue({ gsc: { inspect } } as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const now = Date.now();
    expect(await inspectLive(scope, project, new Date(now))).toEqual({ inspected: 19 });
    // A day later the first run's pages wait their turn behind the two it didn't reach.
    inspect.mockClear();
    await inspectLive(scope, project, new Date(now + 86_400_000 + 1000));
    error.mockRestore();
    expect(inspect.mock.calls.slice(0, 2).map(([, url]) => url).sort()).toEqual(["https://fix.example/p20", "https://fix.example/p21"]);
  });

  it("checks the applied fixes it checked longest ago, so a newer one gets its turn", async () => {
    const urls = Array.from({ length: 55 }, (_, i) => `https://fix.example/q${String(i).padStart(2, "0")}`);
    const { scope, project, rows } = await many("applied", urls);
    vi.mocked(safeFetch).mockReset();
    fetched("");
    const now = Date.now();
    await checkApplied(scope, project, new Date(now));
    await checkApplied(scope, project, new Date(now + 1000));
    // Every fix has been checked at least once across the two runs.
    expect((await rows()).filter((f) => !f.liveCheck)).toEqual([]);
  });
});

describe.skipIf(!ready)("a read-only project", () => {
  it.skipIf(!rules.hasPlans)("refuses every change to its fixes, from the app and from an agent alike", async () => {
    // Free holds one project, so the newer of two is read-only (`lockedProjectIds`), as after a downgrade.
    const [ws] = await db.insert(s.workspaces).values({ name: `fixes-locked-${Date.now()}-${Math.random()}`, plan: "free" }).returning();
    await db.insert(s.projects).values({ workspaceId: ws.id, name: "Kept", domain: "kept.example", createdAt: new Date("2026-01-01") });
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Fix site", domain: "fix.example" }).returning();
    const scope = { workspaceId: ws.id, projectId: project.id };
    await syncAuditFixes({ id: 1, ...scope, target: "fix.example", createdAt: new Date(), startedAt: new Date() }, [finding("missing-h1")], ["https://fix.example/a"]);
    const [fix] = await db.select().from(s.fixes).where(eq(s.fixes.projectId, project.id));

    const readOnly = /read-only/;
    await expect(markFixesApplied(scope, actor, { ids: [fix.id] })).rejects.toThrow(readOnly);
    await expect(markFixesApplied(scope, actor, { ids: [fix.id] }, { dryRun: true })).rejects.toThrow(readOnly);
    await expect(dismissFixes(scope, actor, { ids: [fix.id] })).rejects.toThrow(readOnly);
    await expect(reopenFix(scope, fix.id)).rejects.toThrow(readOnly);
    await expect(verifyFixes(scope, [fix.id])).rejects.toThrow(readOnly);
    const [after] = await db.select().from(s.fixes).where(eq(s.fixes.id, fix.id));
    expect(after.status).toBe("open");
  });
});
