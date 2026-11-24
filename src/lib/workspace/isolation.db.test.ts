import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Workspace isolation, end to end against seopen_test: workspace B must not read or change
 * workspace A's data through loaders, Server Actions, API routes or jobs. The request side is
 * impersonated by mocking `currentWorkspace()`, the one place a request resolves its workspace.
 */

const state = vi.hoisted(() => ({ ws: 0, cookies: new Map<string, string>() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ id: "test-user" }), getCurrentUser: async () => ({ id: "test-user" }) }));
vi.mock("@/lib/workspace/current", async () => {
  const { db } = await import("@/db");
  const { workspaces } = await import("@/db/schema");
  const { eq: eqOp } = await import("drizzle-orm");
  const currentWorkspace = async () => {
    const [ws] = await db.select().from(workspaces).where(eqOp(workspaces.id, state.ws));
    if (!ws) throw new Error("no workspace");
    return ws;
  };
  return { currentWorkspace, workspaceScope: async () => ({ workspaceId: (await currentWorkspace()).id }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined),
    set: (name: string, value: string) => void state.cookies.set(name, String(value)),
    delete: (name: string) => void state.cookies.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {}, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

const ready = await testDb();

// Imported after the mocks above.
const { db } = await import("@/db");
const s = await import("@/db/schema");
const projectsLib = await import("@/lib/projects");
const { jobScope } = await import("@/lib/workspace");

async function seedWorkspace(tag: string) {
  const [ws] = await db.insert(s.workspaces).values({ name: `${tag}-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 10 });
  const [project] = await db
    .insert(s.projects)
    .values({ workspaceId: ws.id, name: `${tag} site`, domain: `${tag}-${ws.id}.example` })
    .returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const [keyword] = await db.insert(s.rankKeywords).values({ ...scope, keyword: `${tag} keyword` }).returning();
  const [list] = await db.insert(s.keywordsLists).values({ ...scope, name: `${tag} list` }).returning();
  await db.insert(s.keywordsListItems).values({ workspaceId: ws.id, listId: list.id, keyword: `${tag} item`, locationCode: 2840, languageCode: "en" });
  const [crawl] = await db.insert(s.auditCrawls).values({ ...scope, target: project.domain, maxPages: 10, status: "done", finishedAt: new Date() }).returning();
  await db.insert(s.auditIssues).values({ workspaceId: ws.id, crawlId: crawl.id, code: "title_missing", url: `https://${project.domain}/` });
  await db.insert(s.backlinksDomainDecisions).values({ ...scope, domain: `spam-${tag}.example`, decision: "disavow" });
  const [prompt] = await db.insert(s.aiPrompts).values({ ...scope, prompt: `best ${tag} tools?`, platforms: ["chat_gpt"] }).returning();
  await db.insert(s.gscDaily).values({ ...scope, date: "2026-10-01", clicks: 42, impressions: 1000, ctr: 0.042, position: 3.5 });
  return { ws, project, scope, keyword, list, crawl, prompt };
}

type Seeded = Awaited<ReturnType<typeof seedWorkspace>>;
let A: Seeded;
let B: Seeded;

/** Act as a request of workspace `w`, with its project picked in the switcher. */
function as(w: Seeded) {
  state.ws = w.ws.id;
  state.cookies.clear();
  state.cookies.set(projectsLib.PROJECT_COOKIE, String(w.project.id));
}

const form = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
};

describe.skipIf(!ready)("workspace isolation", () => {
  beforeAll(async () => {
    A = await seedWorkspace("a");
    B = await seedWorkspace("b");
  });
  afterEach(() => {
    state.ws = 0;
    state.cookies.clear();
  });

  describe("loaders", () => {
    it("lists and resolves only the current workspace's projects", async () => {
      as(B);
      expect((await projectsLib.listProjects()).map((p) => p.id)).toEqual([B.project.id]);
      expect(await projectsLib.getProject(A.project.id)).toBeNull();
      await expect(projectsLib.requireProject(A.project.id)).rejects.toThrow();
      // A cookie naming another workspace's project falls back to one of this workspace's.
      state.cookies.set(projectsLib.PROJECT_COOKIE, String(A.project.id));
      expect((await projectsLib.getCurrentProject())?.id).toBe(B.project.id);
    });

    it("keeps module reads inside the scope, even with another workspace's child ids", async () => {
      const { getKeyword, loadTracker, keywordHistory } = await import("@/modules/rank/queries");
      const { getList, listItems } = await import("@/modules/keywords/lists");
      const { getCrawlForProject, resolveCrawl, issueRows } = await import("@/modules/audit/queries");
      const { listDecisions } = await import("@/modules/backlinks/api");
      const { getPromptDetail } = await import("@/modules/ai/data");
      const { gscTotals } = await import("@/modules/google/data");

      expect(await getKeyword(B.scope, A.keyword.id)).toBeNull();
      expect((await loadTracker(B.scope)).keywords.map((k) => k.id)).toEqual([B.keyword.id]);
      expect(await keywordHistory({ id: A.keyword.id, workspaceId: B.ws.id }, "2000-01-01")).toEqual([]);
      expect(await getList(B.scope, A.list.id)).toBeNull();
      expect(await listItems({ id: A.list.id, workspaceId: B.ws.id })).toEqual([]);
      expect(await getCrawlForProject(B.scope, A.crawl.id)).toBeNull();
      expect((await resolveCrawl(B.scope, String(A.crawl.id))).crawl?.id).toBe(B.crawl.id);
      expect(await issueRows({ id: A.crawl.id, workspaceId: B.ws.id })).toEqual([]);
      expect((await listDecisions(B.scope)).map((d) => d.domain)).toEqual(["spam-b.example"]);
      expect(await getPromptDetail(B.scope, A.prompt.id)).toBeNull();
      expect((await gscTotals(B.scope, { start: "2026-10-01", end: "2026-10-01" })).clicks).toBe(42);

      // A forged scope (B's workspace, A's project) matches nothing: both ids are always filtered.
      const forged = { workspaceId: B.ws.id, projectId: A.project.id };
      expect(await getKeyword(forged, A.keyword.id)).toBeNull();
      expect((await loadTracker(forged)).keywords).toEqual([]);
      expect(await getList(forged, A.list.id)).toBeNull();
      expect(await listDecisions(forged)).toEqual([]);
      expect((await gscTotals(forged, { start: "2026-10-01", end: "2026-10-01" })).clicks).toBe(0);

      // The owner of the data still sees it.
      expect((await getKeyword(A.scope, A.keyword.id))?.id).toBe(A.keyword.id);
      expect((await getPromptDetail(A.scope, A.prompt.id))?.prompt.id).toBe(A.prompt.id);
    });
  });

  describe("server actions", () => {
    it("refuses project actions on another workspace's project", async () => {
      const actions = await import("@/app/actions/projects");
      as(B);
      await expect(actions.saveProjectFromForm(A.project.id, null, form({ name: "pwned", domain: "pwned.example", locationCode: "2840", languageCode: "en" }))).rejects.toThrow();
      await expect(actions.archiveProject(A.project.id)).rejects.toThrow();
      await expect(actions.deleteProject(A.project.id, null, form({ confirm: "delete" }))).rejects.toThrow();
      await expect(actions.selectProject(A.project.id)).rejects.toThrow();
      await expect(actions.removeCompetitor(A.project.id, "x.example")).rejects.toThrow();
      const [a] = await db.select().from(s.projects).where(eq(s.projects.id, A.project.id));
      expect(a).toMatchObject({ name: "a site", archived: false });
      expect(state.cookies.get(projectsLib.PROJECT_COOKIE)).toBe(String(B.project.id));
    });

    it("creates projects in the current workspace only", async () => {
      const actions = await import("@/app/actions/projects");
      as(B);
      const domain = `new-${randomUUID().slice(0, 8)}.example`;
      await actions.createProjectFromForm(null, form({ name: "new", domain, locationCode: "2840", languageCode: "en" })).catch(() => {});
      const [row] = await db.select().from(s.projects).where(eq(s.projects.domain, domain));
      expect(row.workspaceId).toBe(B.ws.id);
      expect(row.name).toBe("new");
    });

    it("deletes an archived project once delete is typed", async () => {
      const actions = await import("@/app/actions/projects");
      as(B);
      const [old] = await db.insert(s.projects).values({ workspaceId: B.ws.id, name: "old", domain: `old-${randomUUID().slice(0, 8)}.example`, archived: true }).returning();
      expect(await actions.deleteProject(old.id, null, form({ confirm: "old" }))).toEqual({ error: "Type delete to confirm." });
      expect(await db.$count(s.projects, eq(s.projects.id, old.id))).toBe(1);
      await expect(actions.deleteProject(old.id, null, form({ confirm: "delete" }))).rejects.toThrow("NEXT_REDIRECT");
      expect(await db.$count(s.projects, eq(s.projects.id, old.id))).toBe(0);
    });

    it("can't touch another workspace's rank keywords, lists, decisions or prompts", async () => {
      const rank = await import("@/modules/rank/actions");
      const keywords = await import("@/modules/keywords/actions");
      const backlinks = await import("@/modules/backlinks/actions");
      const ai = await import("@/modules/ai/actions");
      const google = await import("@/modules/google/actions");
      as(B);

      // Own project, other workspace's child ids: nothing happens.
      await rank.removeKeywords(B.project.id, [A.keyword.id]);
      await rank.setKeywordsActive(B.project.id, [A.keyword.id], false);
      // Lists belong to the current project (B's here), so A's list id matches nothing.
      await keywords.deleteList(A.list.id).catch(() => {}); // redirects afterwards
      await keywords.renameList(A.list.id, { error: null }, form({ name: "pwned" }));
      await ai.deletePrompt(B.project.id, A.prompt.id).catch(() => {}); // redirects afterwards
      await ai.deletePrompts(B.project.id, [A.prompt.id]);
      // Other workspace's project id: refused outright.
      await expect(rank.removeKeywords(A.project.id, [A.keyword.id])).rejects.toThrow();
      await expect(backlinks.setDomainDecision({ projectId: A.project.id, domain: "spam-a.example", decision: "clear" })).rejects.toThrow();
      await expect(ai.setPromptActive(A.project.id, A.prompt.id, false)).rejects.toThrow();
      await expect(google.setProjectProperties(A.project.id, form({ gscProperty: "", ga4Property: "" }))).rejects.toThrow();
      await expect(google.inspectUrl(A.project.id, form({ url: "https://a.example/" }))).rejects.toThrow();

      const [kw] = await db.select().from(s.rankKeywords).where(eq(s.rankKeywords.id, A.keyword.id));
      expect(kw.active).toBe(true);
      const [list] = await db.select().from(s.keywordsLists).where(eq(s.keywordsLists.id, A.list.id));
      expect(list.name).toBe("a list");
      const decisions = await db.select().from(s.backlinksDomainDecisions).where(eq(s.backlinksDomainDecisions.projectId, A.project.id));
      expect(decisions).toHaveLength(1);
      const [prompt] = await db.select().from(s.aiPrompts).where(eq(s.aiPrompts.id, A.prompt.id));
      expect(prompt.active).toBe(true);
    });

    it("sets only the current workspace's time zone, and dates read in it", async () => {
      const { setTimeZone } = await import("@/app/actions/settings");
      const { workspaceTimeZone } = await import("@/lib/workspace");
      as(B);
      await setTimeZone(form({ timeZone: "Asia/Tokyo" }));
      expect(await workspaceTimeZone({ workspaceId: B.ws.id })).toBe("Asia/Tokyo");
      expect(await workspaceTimeZone({ workspaceId: A.ws.id })).toBe("America/New_York");
      as(A);
      await setTimeZone(form({ timeZone: "Europe/London" }));
      expect(await workspaceTimeZone({ workspaceId: A.ws.id })).toBe("Europe/London");
      expect(await workspaceTimeZone({ workspaceId: B.ws.id })).toBe("Asia/Tokyo");
    });

    it("stores a time zone under its canonical name", async () => {
      const { setTimeZone } = await import("@/app/actions/settings");
      as(A);
      await setTimeZone(form({ timeZone: "america/los_angeles" }));
      const [a] = await db.select().from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, A.ws.id));
      expect(a.timeZone).toBe("America/Los_Angeles");
    });

    it("refuses anything but a real time zone and keeps the one set", async () => {
      const { setTimeZone } = await import("@/app/actions/settings");
      as(A);
      await setTimeZone(form({ timeZone: "Europe/Paris" }));
      for (const timeZone of ["Mars/Olympus_Mons", "+05:00", ""]) {
        await expect(setTimeZone(form({ timeZone }))).rejects.toThrow();
      }
      await expect(setTimeZone(new FormData())).rejects.toThrow();
      const [a] = await db.select().from(s.workspaceSettings).where(eq(s.workspaceSettings.workspaceId, A.ws.id));
      expect(a.timeZone).toBe("Europe/Paris");
    });
  });

  describe("API routes", () => {
    it("serves the disavow file only for the current workspace's project", async () => {
      const { GET } = await import("@/app/(app)/backlinks/toxic/disavow/route");
      as(B);
      expect((await GET(new Request(`http://local/backlinks/toxic/disavow?project=${A.project.id}`))).status).toBe(404);
      as(A);
      const res = await GET(new Request(`http://local/backlinks/toxic/disavow?project=${A.project.id}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("domain:spam-a.example");
    });
  });

  describe("jobs", () => {
    const handler = async (name: string) => {
      const allJobs = await (await import("@/lib/jobs/registry")).loadJobs();
      const job = allJobs.find((j) => j.name === name);
      if (!job) throw new Error(`no job ${name}`);
      return (data: object) => job.handler(data, {} as never);
    };

    it("checks the payload's project against its workspace", async () => {
      expect(await jobScope(A.scope)).toMatchObject({ ok: true, scope: A.scope });
      expect(await jobScope({ workspaceId: B.ws.id, projectId: A.project.id })).toMatchObject({ ok: false });
      expect(await jobScope({ projectId: A.project.id })).toMatchObject({ ok: false });
    });

    it("skips a payload that pairs workspace B with workspace A's project, before any work", async () => {
      const forged = { workspaceId: B.ws.id, projectId: A.project.id };
      const cases: [string, object][] = [
        ["rank.schedule", forged],
        ["rank.check", { ...forged, runId: 1 }],
        ["rank.volumes", forged],
        ["audit.start", { ...forged, crawlId: A.crawl.id }],
        ["audit.schedule", forged],
        ["audit.lighthouse", { ...forged, lighthouseId: 1 }],
        ["backlinks.snapshot", forged],
        ["google.gsc.sync", forged],
        ["google.ga4.sync", forged],
        ["ai.run", { ...forged, runId: 1 }],
        ["ai.poll", { ...forged, runId: 1 }],
      ];
      for (const [name, payload] of cases) {
        const result = await (await handler(name))(payload);
        expect(result, name).toMatchObject({ skipped: expect.stringContaining("not in workspace") });
      }
    });

    it("leaves another workspace's queued crawl alone even when the payload names it", async () => {
      const [queued] = await db.insert(s.auditCrawls).values({ ...A.scope, target: "a.example", maxPages: 10 }).returning();
      const start = await handler("audit.start");
      // B's own project with A's crawl id: the claim only matches B's crawls.
      await start({ ...B.scope, crawlId: queued.id });
      const [after] = await db.select().from(s.auditCrawls).where(eq(s.auditCrawls.id, queued.id));
      expect(after.status).toBe("queued");
    });
  });
});
