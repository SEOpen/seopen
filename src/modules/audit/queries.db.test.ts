import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** Counting pages with errors against seopen_test, the number the dashboard's "Pages with errors" row shows. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { doneCrawls, latestHealth, listCrawls, pagesWithErrors, resolveCrawl } = await import("./queries");

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `pages-with-errors-${Date.now()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Errors site", domain: `errors-${ws.id}.example` }).returning();
  const crawl = async () => {
    const [row] = await db.insert(s.auditCrawls).values({ workspaceId: ws.id, projectId: project.id, status: "done", target: project.domain, maxPages: 100 }).returning();
    return row;
  };
  return { ws, crawl };
}

describe.skipIf(!ready)("pagesWithErrors", () => {
  it("counts each page once, however many errors it has, and only error-level issues on pages", async () => {
    const { ws, crawl } = await seed();
    const [a, clean] = [await crawl(), await crawl()];
    const issue = (code: string, url: string) => ({ workspaceId: ws.id, crawlId: a.id, code, url });
    await db.insert(s.auditIssues).values([
      issue("http-4xx", "https://x.example/gone"),
      issue("missing-title", "https://x.example/a"),
      issue("duplicate-title", "https://x.example/a"), // same page again
      issue("not-https", "https://x.example/b"),
      issue("missing-description", "https://x.example/c"), // a warning: not an error
      issue("broken-resources", "https://x.example/logo.png"), // a file, not a page
      issue("invalid-certificate", "https://x.example/"), // the whole site, reported on the homepage
    ]);
    const counts = await pagesWithErrors([a, clean]);
    expect(counts.get(a.id)).toBe(3);
    // A crawl with no errors has no entry; the dashboard reads that as zero.
    expect(counts.has(clean.id)).toBe(false);
  });

  it("gives each project's latest finished crawl, and only this workspace's", async () => {
    const mine = await seed();
    const theirs = await seed();
    const [project] = await db.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.workspaceId, mine.ws.id));
    const crawl = (values: Partial<typeof s.auditCrawls.$inferInsert>) =>
      db.insert(s.auditCrawls).values({ workspaceId: mine.ws.id, projectId: project.id, status: "done", target: "x.example", maxPages: 10, ...values });
    await crawl({ healthScore: 60, finishedAt: new Date("2026-10-01T00:00:00Z") });
    await crawl({ healthScore: 80, finishedAt: new Date("2026-10-08T00:00:00Z") });
    await crawl({ status: "failed", healthScore: 10, finishedAt: new Date("2026-10-09T00:00:00Z") });
    await db.insert(s.auditCrawls).values({ workspaceId: theirs.ws.id, projectId: (await db.select({ id: s.projects.id }).from(s.projects).where(eq(s.projects.workspaceId, theirs.ws.id)))[0].id, status: "done", target: "y.example", maxPages: 10, healthScore: 99, finishedAt: new Date("2026-10-08T00:00:00Z") });
    const rows = await latestHealth(mine.ws.id);
    expect(rows).toEqual([{ projectId: project.id, healthScore: 80 }]);
  });

  it("never reads another workspace's crawl", async () => {
    const mine = await seed();
    const theirs = await seed();
    const crawl = await theirs.crawl();
    await db.insert(s.auditIssues).values({ workspaceId: theirs.ws.id, crawlId: crawl.id, code: "http-4xx", url: "https://x.example/gone" });
    expect((await pagesWithErrors([{ id: crawl.id, workspaceId: mine.ws.id }])).size).toBe(0);
  });

  it("needs no query for no crawls", async () => {
    expect((await pagesWithErrors([])).size).toBe(0);
  });
});

describe.skipIf(!ready)("crawl counts", () => {
  it("reads errors, warnings and notices from the crawl's issues by today's severity, not the stored columns", async () => {
    const { ws, crawl } = await seed();
    const old = await crawl();
    // Stored when nofollow-internal was a warning: 1 + 2 warnings, 1 notice.
    await db.update(s.auditCrawls).set({ errors: 1, warnings: 3, notices: 1, finishedAt: new Date("2026-11-01T00:00:00Z") }).where(eq(s.auditCrawls.id, old.id));
    const issue = (code: string, url: string) => ({ workspaceId: ws.id, crawlId: old.id, code, url });
    await db.insert(s.auditIssues).values([
      issue("http-4xx", "https://x.example/gone"),
      issue("missing-description", "https://x.example/a"),
      issue("nofollow-internal", "https://x.example/a"),
      issue("nofollow-internal", "https://x.example/b"),
      issue("render-blocking", "https://x.example/a"),
    ]);
    const scope = { workspaceId: ws.id, projectId: old.projectId };
    const want = { errors: 1, warnings: 1, notices: 3 };
    expect((await doneCrawls(scope))[0]).toMatchObject(want);
    expect((await listCrawls(scope))[0]).toMatchObject(want);
    expect((await resolveCrawl(scope)).crawl).toMatchObject(want);
  });

  it("leaves a crawl with no stored counts, such as one still running, without any", async () => {
    const { ws, crawl } = await seed();
    const running = await crawl();
    await db.update(s.auditCrawls).set({ status: "crawling" }).where(eq(s.auditCrawls.id, running.id));
    const [row] = await listCrawls({ workspaceId: ws.id, projectId: running.projectId });
    expect(row).toMatchObject({ errors: null, warnings: null, notices: null });
  });
});
