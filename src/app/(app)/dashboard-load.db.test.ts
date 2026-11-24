import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/**
 * The failed-check signal against seopen_test: only a project's newest row counts, whatever the source,
 * and All projects asks with the same few queries however many projects there are.
 */

vi.mock("server-only", () => ({}));

const ready = await testDb();
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { eq } = await import("drizzle-orm");
const { loadFailures, readFailures, withFailures } = await import("./dashboard-load");
const { loadTracker } = await import("@/modules/rank/queries");
const { CRAWL_CANCELLED, plainNextStep } = await import("@/lib/dataforseo/failure-copy");
const { PlausibleAccessError } = await import("@/modules/plausible/types");

const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

async function workspace(values: Partial<typeof s.workspaces.$inferInsert> = {}) {
  const [ws] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal", ...values }).returning();
  return ws;
}

/** A workspace on a plan, with the verified owner paid checks ask for. */
async function owned(values: Partial<typeof s.workspaces.$inferInsert>) {
  const ws = await workspace(values);
  const id = `load-${randomUUID()}`;
  await db.insert(s.users).values({ id, email: `${id}@example.com`, emailVerified: true });
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: id, role: "owner" });
  return ws;
}

async function project(workspaceId: number, over: Partial<typeof s.projects.$inferInsert> = {}) {
  const [p] = await db.insert(s.projects).values({ workspaceId, name: `p-${randomUUID()}`, domain: `${randomUUID()}.example`, ...over }).returning();
  return p;
}

type Project = Awaited<ReturnType<typeof project>>;

const keyword = (p: Project) => db.insert(s.rankKeywords).values({ workspaceId: p.workspaceId, projectId: p.id, keyword: "coffee" });

const rankRun = (p: Project, status: "posting" | "pending" | "done" | "failed", createdAt: Date, error: string | null = null) =>
  db.insert(s.rankRuns).values({ workspaceId: p.workspaceId, projectId: p.id, kind: "manual", date: createdAt.toISOString().slice(0, 10), depth: 10, status, error, createdAt, finishedAt: status === "done" || status === "failed" ? createdAt : null });

const prompt = (p: Project) => db.insert(s.aiPrompts).values({ workspaceId: p.workspaceId, projectId: p.id, prompt: "best coffee", platforms: ["chatgpt"] });

const aiRun = (p: Project, status: "queued" | "running" | "done" | "failed", startedAt: Date, error: string | null = null) => db.insert(s.aiRuns).values({ workspaceId: p.workspaceId, projectId: p.id, status, error, startedAt });

const crawl = (p: Project, status: "queued" | "crawling" | "done" | "failed", createdAt: Date, error: string | null = null) =>
  db.insert(s.auditCrawls).values({ workspaceId: p.workspaceId, projectId: p.id, target: p.domain, maxPages: 100, status, error, createdAt });

async function business(p: Project, keywords = true) {
  const [b] = await db.insert(s.localBusinesses).values({ workspaceId: p.workspaceId, projectId: p.id, query: "q", city: "c", title: "Fernhill", lat: 1, lng: 1 }).returning();
  if (keywords) await db.insert(s.localKeywords).values({ workspaceId: p.workspaceId, businessId: b.id, keyword: "coffee" });
  return b;
}

const localCheck = (p: Project, businessId: number, status: "posting" | "pending" | "done" | "failed", createdAt: Date, error: string | null = null) =>
  db.insert(s.localChecks).values({ workspaceId: p.workspaceId, projectId: p.id, businessId, kind: "manual", gridSize: 5, radiusMiles: 5, zoom: 13, lat: 1, lng: 1, status, error, createdAt, finishedAt: status === "done" || status === "failed" ? createdAt : null });

const failuresOf = async (p: Project) => (await loadFailures([p], "UTC")).get(p.id)!;

describe.runIf(ready)("loadFailures", () => {
  let ws: Awaited<ReturnType<typeof workspace>>;
  let p: Project;

  beforeEach(async () => {
    ws = await workspace();
    p = await project(ws.id);
  });

  it("reaches the results the pages read, on that module only", async () => {
    const ws = await workspace();
    const p = await project(ws.id);
    await keyword(p);
    await rankRun(p, "failed", hoursAgo(1), "No answer from DataForSEO");
    const result = (id: string) => ({ module: { id }, status: "empty" }) as unknown as Parameters<typeof withFailures>[0][number];
    const [rank, audit] = withFailures([result("rank"), result("audit")], (await loadFailures([p], "UTC")).get(p.id));
    expect(rank.lastRunFailed?.reason).not.toContain("DataForSEO");
    expect(rank.lastRunFailed?.kind).toBe("failed");
    expect(audit.lastRunFailed).toBeUndefined();
  });

  it("finds nothing on a project that never ran", async () => {
    await keyword(p);
    await prompt(p);
    await business(p);
    expect((await failuresOf(p)).size).toBe(0);
  });

  describe("rankings", () => {
    beforeEach(() => keyword(p));

    it("failed then succeeded: clear", async () => {
      await rankRun(p, "failed", hoursAgo(5), "No answer from DataForSEO");
      await rankRun(p, "done", hoursAgo(1));
      expect((await failuresOf(p)).has("rank")).toBe(false);
    });

    it("succeeded then failed: says so, without the vendor's words", async () => {
      await rankRun(p, "done", hoursAgo(5));
      await rankRun(p, "failed", hoursAgo(1), "No answer from DataForSEO");
      const f = (await failuresOf(p)).get("rank");
      expect(f).toMatchObject({ kind: "failed", noun: "check", retry: true });
      expect(f?.reason).not.toMatch(/DataForSEO/);
    });

    it("running after a failure: not a failure", async () => {
      await rankRun(p, "failed", hoursAgo(5));
      await rankRun(p, "pending", hoursAgo(1));
      expect((await failuresOf(p)).has("rank")).toBe(false);
    });

    it("a young posting run is running; one past the hour is stuck", async () => {
      await rankRun(p, "posting", hoursAgo(0.5));
      expect((await failuresOf(p)).has("rank")).toBe(false);
      await db.update(s.rankRuns).set({ createdAt: hoursAgo(2) }).where(eq(s.rankRuns.projectId, p.id));
      expect((await failuresOf(p)).get("rank")?.reason).toBe("This check didn't start.");
    });

    it("says nothing once no keyword is tracked", async () => {
      await db.update(s.rankKeywords).set({ active: false }).where(eq(s.rankKeywords.projectId, p.id));
      await rankRun(p, "failed", hoursAgo(1));
      expect((await failuresOf(p)).has("rank")).toBe(false);
    });

    it("says nothing once the customer turned the tracker off", async () => {
      await rankRun(p, "failed", hoursAgo(1));
      await db.insert(s.rankSettings).values({ workspaceId: p.workspaceId, projectId: p.id, enabled: false });
      expect((await failuresOf(p)).has("rank")).toBe(false);
      await db.update(s.rankSettings).set({ enabled: true }).where(eq(s.rankSettings.projectId, p.id));
      expect((await failuresOf(p)).has("rank")).toBe(true);
    });
  });

  describe("the plan", () => {
    const allFailed = async (q: Project) => {
      await keyword(q);
      await rankRun(q, "failed", hoursAgo(1));
      await prompt(q);
      await aiRun(q, "failed", hoursAgo(1), "Timed out");
      await crawl(q, "failed", hoursAgo(1), "Timed out");
      const b = await business(q);
      await localCheck(q, b.id, "failed", hoursAgo(1));
    };

    it.skipIf(!rules.hasPlans)("Free: no alarm from what the plan rules out, so no newer run has to clear it", async () => {
      const q = await project((await owned({ plan: "free" })).id);
      await allFailed(q);
      expect([...(await failuresOf(q)).keys()]).toEqual(["audit"]);
    });

    it.skipIf(!rules.hasPlans)("a locked project: no alarm at all", async () => {
      const ws = await owned({ plan: "starter" });
      const projects = [];
      for (let i = 0; i < 4; i++) projects.push(await project(ws.id, { createdAt: hoursAgo(100 - i) }));
      const locked = projects.at(-1)!;
      await allFailed(locked);
      await allFailed(projects[0]);
      const out = await loadFailures(projects, "UTC");
      expect(out.get(locked.id)!.size).toBe(0);
      expect(out.get(projects[0].id)!.size).toBe(4);
    });

    it("suspended: the failure stands, without the offer, and Billing isn't where it's fixed", async () => {
      const q = await project((await owned({ plan: "starter", status: "suspended" })).id);
      await allFailed(q);
      const rank = (await failuresOf(q)).get("rank");
      expect(rank).toMatchObject({ retry: false, next: { label: "View" } });
      expect(rank?.blocked).toMatch(/suspended/);
    });

    it.skipIf(!rules.hasPlans)("a stale posting row on a workspace out of spend gives the reason and the way forward", async () => {
      const ws = await owned({ plan: "starter" });
      await db.insert(s.workspaceUsage).values({ workspaceId: ws.id, month: new Date().toISOString().slice(0, 7) + "-01", spentUsd: 100_000 });
      const q = await project(ws.id);
      await keyword(q);
      await rankRun(q, "posting", hoursAgo(2));
      const rank = (await failuresOf(q)).get("rank");
      expect(rank).toMatchObject({ stuck: true, retry: false, reason: "This check didn't start." });
      expect(rank?.blocked).toBeTruthy();
    });

    it.skipIf(!rules.hasPlans)("a stale posting row with spend left offers the button", async () => {
      const q = await project((await owned({ plan: "starter" })).id);
      await keyword(q);
      await rankRun(q, "posting", hoursAgo(2));
      expect((await failuresOf(q)).get("rank")).toMatchObject({ stuck: true, retry: true, reason: "This check didn't start." });
    });
  });

  describe("AI visibility", () => {
    beforeEach(() => prompt(p));

    it("reads only the newest run", async () => {
      await aiRun(p, "failed", hoursAgo(5), "Timed out");
      await aiRun(p, "done", hoursAgo(1));
      expect((await failuresOf(p)).has("ai")).toBe(false);
      await aiRun(p, "failed", hoursAgo(0.5), "Timed out");
      expect((await failuresOf(p)).get("ai")).toMatchObject({ noun: "run", retry: true });
    });

    it("leaves a run stuck queued for a month alone: nothing says it's stuck", async () => {
      await aiRun(p, "failed", hoursAgo(800));
      await aiRun(p, "queued", hoursAgo(720));
      expect((await failuresOf(p)).has("ai")).toBe(false);
    });
  });

  describe("Site audit", () => {
    it("reads only the newest crawl, and offers Project settings on a rejected domain", async () => {
      await crawl(p, "done", hoursAgo(5));
      await crawl(p, "failed", hoursAgo(1), "40501 Invalid Field");
      expect((await failuresOf(p)).get("audit")).toMatchObject({ noun: "crawl", retry: false, next: { href: `/projects/${p.id}/settings` } });
      await crawl(p, "done", hoursAgo(0.5));
      expect((await failuresOf(p)).has("audit")).toBe(false);
    });

    it("doesn't call a crawl the customer cancelled a failure", async () => {
      await crawl(p, "failed", hoursAgo(1), CRAWL_CANCELLED);
      expect((await failuresOf(p)).has("audit")).toBe(false);
    });

    it("leaves a queued crawl alone", async () => {
      await crawl(p, "failed", hoursAgo(5));
      await crawl(p, "queued", hoursAgo(1));
      expect((await failuresOf(p)).has("audit")).toBe(false);
    });
  });

  describe("Local SEO", () => {
    it("is per business: one healthy business doesn't clear another", async () => {
      const a = await business(p);
      const b = await business(p);
      await localCheck(p, a.id, "failed", hoursAgo(1));
      await localCheck(p, b.id, "done", hoursAgo(0.5));
      expect((await failuresOf(p)).get("local")).toMatchObject({ retry: true, next: { href: `/local/${a.id}` } });
      await localCheck(p, a.id, "done", hoursAgo(0.2));
      expect((await failuresOf(p)).has("local")).toBe(false);
    });

    it("joins several failing businesses into one line", async () => {
      const a = await business(p);
      const b = await business(p);
      await localCheck(p, a.id, "failed", hoursAgo(2));
      await localCheck(p, b.id, "failed", hoursAgo(1));
      expect((await failuresOf(p)).get("local")).toMatchObject({ reason: "The latest checks failed for 2 businesses.", next: { href: "/local" } });
    });

    it("says nothing of a business the customer took off the schedule", async () => {
      const b = await business(p);
      await localCheck(p, b.id, "failed", hoursAgo(1));
      await db.update(s.localBusinesses).set({ scheduled: false }).where(eq(s.localBusinesses.id, b.id));
      expect((await failuresOf(p)).has("local")).toBe(false);
    });
  });

  describe("Search Console and Analytics", () => {
    const sync = (q: Project, source: string, property: string, status: string, message: string | null, lastRunAt: Date) => db.insert(s.googleSyncState).values({ workspaceId: q.workspaceId, projectId: q.id, source, property, status: status as never, message, lastRunAt });
    const account = (workspaceId: number, status: "active" | "reauth_required", connectedAt = hoursAgo(100)) =>
      db.insert(s.googleAccounts).values({ workspaceId, email: "a@example.com", googleSub: randomUUID(), refreshTokenEnc: "x", scopes: [], status, connectedAt });

    it("asks to reconnect a project mapped to a broken account, and only that", async () => {
      const mapped = await project(ws.id, { gscProperty: "sc-domain:example.com" });
      await account(ws.id, "reauth_required");
      expect((await failuresOf(mapped)).get("google")).toMatchObject({ kind: "reconnect", provider: "Google", next: { href: "/gsc" } });
      expect((await failuresOf(p)).has("google")).toBe(false);
    });

    it("clears a refused sync once the account is connected again", async () => {
      const mapped = await project(ws.id, { gscProperty: "sc-domain:example.com" });
      await account(ws.id, "active", hoursAgo(1));
      await sync(mapped, "gsc", "sc-domain:example.com", "reauth", "Reconnect Google.", hoursAgo(5));
      expect((await failuresOf(mapped)).has("google")).toBe(false);
    });

    it.each(["PostHog", "Plausible"] as const)("clears a refused %s sync once it's connected again, and says Reconnect until then", async (provider) => {
      const mapped = await project(ws.id, provider === "PostHog" ? { posthogProject: "1" } : { plausibleSite: "example.com" });
      const connect = (connectedAt: Date) =>
        provider === "PostHog"
          ? db.insert(s.posthogAccounts).values({ workspaceId: ws.id, region: "us", accessTokenEnc: "x", accessTokenExpiresAt: hoursAgo(-1), scopes: [], scopedTeams: [], connectedAt })
          : db.insert(s.plausibleAccounts).values({ workspaceId: ws.id, apiKeyEnc: "x", connectedAt });
      await connect(hoursAgo(10));
      await sync(mapped, provider.toLowerCase(), provider === "PostHog" ? "1" : "example.com", "reauth", `Reconnect ${provider}.`, hoursAgo(5));
      expect((await failuresOf(mapped)).get("ga4")).toMatchObject({ kind: "reconnect", provider });
      const table = provider === "PostHog" ? s.posthogAccounts : s.plausibleAccounts;
      await db.update(table).set({ connectedAt: hoursAgo(1) }).where(eq(table.workspaceId, ws.id));
      expect((await failuresOf(mapped)).has("ga4")).toBe(false);
    });

    it("doesn't ask to reconnect Plausible over a plan that lacks the Stats API", async () => {
      const mapped = await project(ws.id, { plausibleSite: "example.com" });
      await db.insert(s.plausibleAccounts).values({ workspaceId: ws.id, apiKeyEnc: "x", connectedAt: hoursAgo(10) });
      // The words a real refusal stores, so a reworded one can't quietly go back to Reconnect.
      await sync(mapped, "plausible", "example.com", "reauth", plainNextStep(new PlausibleAccessError("plan"), "unknown"), hoursAgo(5));
      expect((await failuresOf(mapped)).get("ga4")).toMatchObject({ kind: "failed", retry: false, next: { label: "View" } });
    });

    it("reads a failed sync on the mapped property, not one left from an earlier mapping", async () => {
      const mapped = await project(ws.id, { ga4Property: "properties/2" });
      await account(ws.id, "active");
      await sync(mapped, "ga4", "properties/1", "error", "This sync didn't finish.", hoursAgo(1));
      expect((await failuresOf(mapped)).has("ga4")).toBe(false);
      await db.update(s.googleSyncState).set({ property: "properties/2" }).where(eq(s.googleSyncState.projectId, mapped.id));
      expect((await failuresOf(mapped)).get("ga4")).toMatchObject({ kind: "failed", noun: "sync", reason: "This sync didn't finish." });
    });

    it("doesn't treat a running or rate-limited sync as failed", async () => {
      const mapped = await project(ws.id, { gscProperty: "sc-domain:example.com" });
      await account(ws.id, "active");
      await sync(mapped, "gsc", "sc-domain:example.com", "running", null, hoursAgo(1));
      expect((await failuresOf(mapped)).has("google")).toBe(false);
      await db.update(s.googleSyncState).set({ status: "quota" }).where(eq(s.googleSyncState.projectId, mapped.id));
      expect((await failuresOf(mapped)).has("google")).toBe(false);
    });
  });

  it("doesn't read another workspace's rows", async () => {
    const other = await workspace();
    const theirs = await project(other.id);
    await keyword(theirs);
    await rankRun(theirs, "failed", hoursAgo(1));
    const out = await loadFailures([p], "UTC");
    expect(out.has(theirs.id)).toBe(false);
    expect(out.get(p.id)!.size).toBe(0);
  });

  it("a source that can't be read comes back empty and logged, so it can't take a page with it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await readFailures("Search Console", () => Promise.reject(new Error("down")))).size).toBe(0);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  describe("All projects", () => {
    beforeAll(() => vi.restoreAllMocks());

    /** Queries started while reading these projects. */
    async function queriesFor(projects: Project[]) {
      const spies = [vi.spyOn(db, "select"), vi.spyOn(db, "selectDistinct"), vi.spyOn(db, "selectDistinctOn")];
      await loadFailures(projects, "UTC");
      const count = spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
      spies.forEach((spy) => spy.mockRestore());
      return count;
    }

    async function failingProject() {
      const q = await project(ws.id, { gscProperty: "sc-domain:example.com" });
      await keyword(q);
      await rankRun(q, "failed", hoursAgo(1));
      await prompt(q);
      await aiRun(q, "failed", hoursAgo(1));
      await crawl(q, "failed", hoursAgo(1));
      const b = await business(q);
      await localCheck(q, b.id, "failed", hoursAgo(1));
      return q;
    }

    it("asks the same number of queries for two projects as for eight", async () => {
      const projects = [];
      for (let i = 0; i < 8; i++) projects.push(await failingProject());
      const two = await queriesFor(projects.slice(0, 2));
      const eight = await queriesFor(projects);
      expect(eight).toBe(two);
      const out = await loadFailures(projects, "UTC");
      for (const q of projects) expect([...out.get(q.id)!.keys()].sort()).toEqual(["ai", "audit", "local", "rank"]);
    });
  });
});

describe.runIf(ready)("loadTracker", () => {
  it("keeps the last good check when more than five failed since, and says the newest failed", async () => {
    const ws = await workspace();
    const p = await project(ws.id);
    await keyword(p);
    await rankRun(p, "done", hoursAgo(100));
    for (let i = 6; i > 0; i--) await rankRun(p, "failed", hoursAgo(i));
    const state = await loadTracker({ workspaceId: ws.id, projectId: p.id });
    expect(state.lastRun?.status).toBe("done");
    expect(state.newestRun?.status).toBe("failed");
    expect(state.activeRun).toBeNull();
  });

  it("doesn't hold Check now back for a run stuck posting past the hour, but does for a young one", async () => {
    const ws = await workspace();
    const p = await project(ws.id);
    // Young first: other files' pollOnce closes every run posting past the hour in seopen_test, so a
    // run that starts old could be closed before the young half reads it.
    await rankRun(p, "posting", hoursAgo(0.5));
    expect((await loadTracker({ workspaceId: ws.id, projectId: p.id })).activeRun?.status).toBe("posting");
    await db.update(s.rankRuns).set({ createdAt: hoursAgo(2) }).where(eq(s.rankRuns.projectId, p.id));
    expect((await loadTracker({ workspaceId: ws.id, projectId: p.id })).activeRun).toBeNull();
  });
});
