import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** Logged changes (`recordChanges`) against seopen_test: one manual record per page, checked and measured like any fix. */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/web/fetch", () => ({ safeFetch: vi.fn(), fetchErrorMessage: () => "That site didn't answer." }));
vi.mock("@/modules/google/apis", () => ({ googleApis: vi.fn() }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { safeFetch } = await import("@/lib/web/fetch");
const { dismissFixes, recordChanges, siteUrl, verifyFixes } = await import("./ops");
const { syncAuditFixes } = await import("./sync");
const { fixCounts, fixDetail, fixSummary, listFixes, liveDaysForPage, loggedChanges } = await import("./queries");
const { dueResults } = await import("./measure");
const { jobs } = await import("./jobs");

const page = (title: string, h1 = "Heading", body = "") => `<html><head><title>${title}</title><meta name="description" content="Words"></head><body><h1>${h1}</h1>${body}</body></html>`;
const fetched = (html: string, status = 200) => vi.mocked(safeFetch).mockResolvedValue({ url: "", status, headers: {}, body: html, truncated: false, redirects: [], ms: 1 });
const actor = { userId: "u1", source: "mcp" as const };

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `record-${Date.now()}-${Math.random()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Fix site", domain: "fix.example" }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const rows = () => db.select().from(s.fixes).where(eq(s.fixes.projectId, project.id));
  const byId = async (id: number) => (await db.select().from(s.fixes).where(and(eq(s.fixes.projectId, project.id), eq(s.fixes.id, id))))[0];
  return { scope, rows, byId };
}

describe("siteUrl", () => {
  it("joins a path to the domain and keeps a URL on the site", () => {
    expect(siteUrl("/pricing", "fix.example")).toEqual({ url: "https://fix.example/pricing" });
    expect(siteUrl(" https://www.fix.example/a?x=1#top ", "fix.example")).toEqual({ url: "https://www.fix.example/a?x=1" });
    expect(siteUrl("https://blog.fix.example/post", "fix.example")).toEqual({ url: "https://blog.fix.example/post" });
  });

  it("refuses anything that isn't a page on the site", () => {
    expect(siteUrl("https://other.example/a", "fix.example")).toEqual({ why: "That isn't on fix.example." });
    expect(siteUrl("pricing", "fix.example")).toMatchObject({ why: expect.stringContaining("path such as /pricing") });
    expect(siteUrl("ftp://fix.example/a", "fix.example")).toMatchObject({ why: expect.stringContaining("http") });
    expect(siteUrl("", "fix.example")).toEqual({ why: "That's empty." });
  });
});

describe.skipIf(!ready)("logging a change", () => {
  beforeEach(() => vi.mocked(safeFetch).mockReset());

  it("previews without writing, then makes one applied manual record per page with the live page as the before", async () => {
    const { scope, rows } = await seed();
    const input = { urls: ["/a", "https://fix.example/a", "https://www.fix.example/b", "https://other.example/c"], commit: "abc123", files: ["app/a/page.tsx"], note: "Rewrote the title and intro.", expect: "New title" };
    const dry = await recordChanges(scope, actor, input, { dryRun: true });
    expect(dry).toMatchObject({ recorded: [{ id: null, url: "https://fix.example/a" }, { id: null, url: "https://www.fix.example/b" }], skipped: [{ url: "https://other.example/c", why: "That isn't on fix.example." }], message: "Would log a change on 2 pages." });
    expect(await rows()).toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();

    fetched(page("Old title"));
    const done = await recordChanges(scope, actor, input);
    expect(done.recorded).toHaveLength(2);
    expect(done.message).toContain("verify_fix");
    const [a] = (await rows()).filter((r) => r.url === "https://fix.example/a");
    expect(a).toMatchObject({ source: "manual", code: "manual-change", status: "applied", appliedVia: "mcp", appliedCommit: "abc123", appliedFiles: ["app/a/page.tsx"], appliedNote: "Rewrote the title and intro.", detail: "Rewrote the title and intro.", evidence: { expect: "New title" }, before: { title: "Old title", h1: "Heading", from: "live" } });
  });

  it("checks the live page for the text it named, and get_fix and list_fixes read it", async () => {
    const { scope, byId } = await seed();
    fetched(page("Old title"));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/a"], expect: "new title for the page" })).recorded;

    const { fixes: [early] } = await verifyFixes(scope, [id!]);
    expect(early).toMatchObject({ status: "applied", live_check: { state: "still_there" } });
    fetched(page("New Title  for the Page"));
    const { fixes: [live] } = await verifyFixes(scope, [id!]);
    expect(live).toMatchObject({ status: "live", live_check: { state: "fixed" } });

    const fix = await byId(id!);
    expect(fixSummary(fix)).toMatchObject({ source: "manual", kind: "code", title: "A change you logged", issue: "/a was changed. SEOpen looks for “new title for the page” on the live page." });
    expect(await fixDetail(scope, fix, { showResults: true })).toMatchObject({ applied: { via: "mcp" }, live: { state: "fixed" } });
    expect((await listFixes(scope, { source: "manual", status: ["live"] })).rows.map((r) => r.id)).toEqual([id]);
    expect((await listFixes(scope, { source: "audit", status: ["live"] })).rows).toEqual([]);
  });

  it("takes the page's 28 days of impressions, under any of its addresses", async () => {
    const { scope, byId } = await seed();
    await db.insert(s.gscDaily).values({ ...scope, date: "2026-10-28", clicks: 10, impressions: 3_000, ctr: 0, position: 5 });
    await db.insert(s.gscPages).values([
      { ...scope, date: "2026-10-27", page: "https://www.fix.example/a/", clicks: 1, impressions: 150, ctr: 0, position: 5 },
      { ...scope, date: "2026-10-28", page: "https://fix.example/a", clicks: 1, impressions: 50, ctr: 0, position: 5 },
      { ...scope, date: "2026-09-01", page: "https://fix.example/a", clicks: 1, impressions: 900, ctr: 0, position: 5 },
    ]);
    fetched(page("Old title"));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/a"] })).recorded;
    expect(fixSummary(await byId(id!))).toMatchObject({ impressions_28d: 200 });
  });

  it("goes live from the daily job once the title, description or H1 changes, with no text named", async () => {
    const { scope, byId } = await seed();
    fetched(page("Same", "Old heading"));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/a"] })).recorded;
    const job = jobs.find((j) => j.name === "fixes.daily")!;
    const run = () => (job.handler as (p: unknown) => Promise<Record<string, unknown>>)(scope);
    expect(await run()).toMatchObject({ checked: 1, live: 0 });
    fetched(page("Same", "New heading"));
    expect(await run()).toMatchObject({ checked: 1, live: 1 });
    expect(await byId(id!)).toMatchObject({ status: "live", liveCheck: { saw: "The H1 changed to “New heading”." } });
  });

  it("refuses a page whose change is still applied or live, naming its status and date", async () => {
    const { scope, byId, rows } = await seed();
    fetched(page("Old"));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/a"] })).recorded;
    const again = await recordChanges(scope, actor, { urls: ["https://www.fix.example/a/"] });
    expect(again.recorded).toEqual([]);
    expect(again.skipped[0].why).toMatch(/^A change to this page was logged on [A-Z][a-z]{2} \d{1,2} and is waiting to go live/);

    await db.update(s.fixes).set({ status: "live", liveAt: new Date("2026-11-03T12:00:00Z") }).where(eq(s.fixes.id, id!));
    expect((await recordChanges(scope, actor, { urls: ["/a"] }, { dryRun: true })).skipped[0].why).toMatch(/went live on Nov 3 and is being measured/);
    expect(await rows()).toHaveLength(1);
    expect((await byId(id!)).status).toBe("live");
  });

  it("starts a settled page over as a new record, keeping nothing from the last one", async () => {
    const { scope, byId, rows } = await seed();
    fetched(page("First"));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/a"], commit: "one", expect: "First text", files: ["a.tsx"] })).recorded;
    const old = { status: "measured", liveAt: new Date("2026-10-01"), liveCheck: { state: "fixed" as const, saw: "x", checkedAt: "2026-10-01", status: 200 }, recrawledAt: new Date("2026-10-02"), inspectedAt: new Date("2026-10-02"), results: { "7": {} as never } };
    await db.update(s.fixes).set(old).where(eq(s.fixes.id, id!));

    fetched(page("Second"));
    const again = await recordChanges(scope, actor, { urls: ["https://www.fix.example/a"], commit: "two" });
    expect(again.recorded).toEqual([{ id, url: "https://fix.example/a" }]);
    expect(await rows()).toHaveLength(1);
    expect(await byId(id!)).toMatchObject({ status: "applied", appliedCommit: "two", appliedFiles: null, evidence: null, detail: null, liveAt: null, liveCheck: null, recrawledAt: null, inspectedAt: null, results: null, before: { title: "Second" } });

    await dismissFixes(scope, actor, { ids: [id!], reason: "Logged by mistake" });
    expect((await recordChanges(scope, actor, { urls: ["/a"], note: "Third" })).recorded).toEqual([{ id, url: "https://fix.example/a" }]);
    expect(await byId(id!)).toMatchObject({ status: "applied", dismissedAt: null, dismissedReason: null, detail: "Third" });
  });

  it("logs links added to a page on that page, and goes live once every linking page has the link", async () => {
    const { scope, byId } = await seed();
    vi.mocked(safeFetch).mockImplementation(async (url) => ({ url: "", status: 200, headers: {}, body: page(String(url).endsWith("/a") ? "Post A" : "Post B", "Heading", String(url).endsWith("/a") ? '<a href="/pricing">plans</a>' : ""), truncated: false, redirects: [], ms: 1 }));
    const input = { urls: ["/pricing"], linkedFrom: ["/a", "https://www.fix.example/b/", "/a/"], commit: "abc", note: "Linked from two posts." };
    expect((await recordChanges(scope, actor, input, { dryRun: true })).recorded).toEqual([{ id: null, url: "https://fix.example/pricing" }]);
    const [{ id }] = (await recordChanges(scope, actor, input)).recorded;
    const fix = await byId(id!);
    expect(fix).toMatchObject({ url: "https://fix.example/pricing", evidence: { linked_from: ["https://fix.example/a", "https://www.fix.example/b/"] } });
    expect(fixSummary(fix)).toMatchObject({ issue: "/pricing was changed: Linked from two posts. SEOpen checks that /a and /b/ link to it.", applied_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), applied_commit: "abc" });

    const { fixes: [early] } = await verifyFixes(scope, [id!]);
    expect(early).toMatchObject({ status: "applied", live_check: { state: "still_there", saw: "1 of 2 pages link to /pricing. Not yet: /b/." } });
    expect(fixSummary(await byId(id!))).toMatchObject({ live_check: "still_there" });
    fetched(page("Post", "Heading", '<a href="https://fix.example/pricing">plans</a>'));
    const { fixes: [live] } = await verifyFixes(scope, [id!]);
    expect(live).toMatchObject({ status: "live", live_check: { state: "fixed", saw: "All 2 pages link to /pricing." } });
  });

  it("with linked_from and expect, also looks for the text on the linked page", async () => {
    const { scope } = await seed();
    fetched(page("Old pricing", "Heading", '<a href="/pricing">plans</a>'));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/pricing"], linkedFrom: ["/a"], expect: "Plans for small teams" })).recorded;
    expect((await verifyFixes(scope, [id!])).fixes[0]).toMatchObject({ live_check: { state: "still_there", saw: "The page doesn't contain “Plans for small teams” yet." } });
    fetched(page("Plans for small teams", "Heading", '<a href="/pricing">plans</a>'));
    expect((await verifyFixes(scope, [id!])).fixes[0]).toMatchObject({ status: "live", live_check: { state: "fixed", saw: "/a links to /pricing. The page contains “Plans for small teams”." } });
  });

  it("refuses linked_from with more than one page, off the site, or naming the page itself", async () => {
    const { scope, rows } = await seed();
    await expect(recordChanges(scope, actor, { urls: ["/x", "/y"], linkedFrom: ["/a"] }, { dryRun: true })).rejects.toThrow(/log that one page/);
    await expect(recordChanges(scope, actor, { urls: ["/x"], linkedFrom: ["https://other.example/a"] })).rejects.toThrow("https://other.example/a in linked_from: That isn't on fix.example.");
    await expect(recordChanges(scope, actor, { urls: ["/x"], linkedFrom: ["https://www.fix.example/x/"] })).rejects.toThrow(/can't count as a page linking to it/);
    await expect(recordChanges(scope, actor, { urls: ["/x"], linkedFrom: Array.from({ length: 21 }, (_, i) => `/p${i}`) })).rejects.toThrow(/can name 20/);
    expect(await rows()).toEqual([]);
  });

  it("refuses too many pages and an over-long text, and a sync leaves manual records alone", async () => {
    const { scope, rows } = await seed();
    await expect(recordChanges(scope, actor, { urls: [] })).rejects.toThrow("Name at least one page.");
    await expect(recordChanges(scope, actor, { urls: Array.from({ length: 51 }, (_, i) => `/p${i}`) })).rejects.toThrow(/one call can take 50/);
    await expect(recordChanges(scope, actor, { urls: ["/a"], expect: "x".repeat(301) })).rejects.toThrow(/Keep it to 300/);

    fetched(page("Old"));
    await recordChanges(scope, actor, { urls: ["/a"] });
    await syncAuditFixes({ id: 1, ...scope, target: "fix.example", createdAt: new Date(), startedAt: new Date() }, [], ["https://fix.example/a"]);
    expect(await rows()).toMatchObject([{ source: "manual", status: "applied" }]);
  });

  it("lists on their own for the Fixes page, newest first, outside the findings' counts", async () => {
    const { scope } = await seed();
    await syncAuditFixes({ id: 1, ...scope, target: "fix.example", createdAt: new Date(), startedAt: new Date() }, [{ code: "missing-h1", url: "https://fix.example/z", detail: null }], ["https://fix.example/z"]);
    fetched(page("Old"));
    await recordChanges(scope, actor, { urls: ["/a"] });
    await recordChanges(scope, actor, { urls: ["/b"] });
    expect((await loggedChanges(scope)).rows.map((r) => r.url)).toEqual(["https://fix.example/b", "https://fix.example/a"]);
    expect(await fixCounts(scope, { notSource: "manual" })).toMatchObject({ open: 1, applied: 0 });
    expect(await fixCounts(scope)).toMatchObject({ open: 1, applied: 2 });
    expect((await listFixes(scope, { status: ["applied"], notSource: "manual" })).total).toBe(0);
  });

  it("gives a page's chart the days its fixes went live, on any address it's reported under", async () => {
    const { scope } = await seed();
    await syncAuditFixes({ id: 1, ...scope, target: "fix.example", createdAt: new Date(), startedAt: new Date() }, [{ code: "missing-h1", url: "https://fix.example/a", detail: null }, { code: "missing-h1", url: "https://fix.example/b", detail: null }], ["https://fix.example/a", "https://fix.example/b"]);
    fetched(page("Old"));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/a"], note: "Rewrote the title" })).recorded;
    expect(await liveDaysForPage(scope, "https://www.fix.example/a/")).toEqual([]);
    await db.update(s.fixes).set({ status: "live", liveAt: new Date("2026-11-03T15:00:00Z") }).where(eq(s.fixes.id, id!));
    await db.update(s.fixes).set({ status: "measured", liveAt: new Date("2026-10-01T15:00:00Z") }).where(and(eq(s.fixes.projectId, scope.projectId), eq(s.fixes.code, "missing-h1")));
    expect(await liveDaysForPage(scope, "https://www.fix.example/a/")).toEqual([
      { date: "2026-10-01", label: "Pages have no H1 heading" },
      { date: "2026-11-03", label: "Rewrote the title" },
    ]);
  });

  it("measures the page like any fix", async () => {
    const { scope, byId } = await seed();
    const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
    for (let d = 1; d <= 29; d++) {
      await db.insert(s.gscPages).values({ ...scope, date: day(d), page: "https://fix.example/a", clicks: d < 15 ? 2 : 3, impressions: 30, ctr: 0.1, position: 5 });
      await db.insert(s.gscDaily).values({ ...scope, date: day(d), clicks: 100, impressions: 1000, ctr: 0.1, position: 5 });
    }
    fetched(page("Old"));
    const [{ id }] = (await recordChanges(scope, actor, { urls: ["/a"] })).recorded;
    const fix = { ...(await byId(id!)), status: "live", liveAt: new Date("2026-10-15T20:00:00Z") };
    const due = await dueResults(scope, fix, { first: day(1), last: day(29) });
    expect(due["14"]).toMatchObject({ before: { clicks: 28 }, after: { clicks: 42 } });
  });
});
