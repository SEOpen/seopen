import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

// A Free project claims its site under a key from SEOPEN_SECRET_KEY.
process.env.SEOPEN_SECRET_KEY ??= randomBytes(32).toString("base64");

const state = vi.hoisted(() => ({ ws: 0 }));
const enqueue = vi.hoisted(() => vi.fn(async () => "job"));

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
const cookieSet = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: cookieSet, delete: () => {} }), headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ refresh: () => {}, revalidatePath: () => {}, revalidateTag: () => {}, cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue }));

const ready = await testDb();

// Imported after the mocks above.
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { createProjectFromForm, selectProject } = await import("./projects");

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

const newProject = (extra: Record<string, string> = {}) => form({ domain: `${randomUUID()}.example`, name: "", locationCode: "2840", languageCode: "en", cityCode: "", competitors: "", ...extra });

/** Creates a project through the form's action, and gives back the row it made and where it went. */
async function create(values: FormData) {
  const to = await createProjectFromForm(null, values).then(
    () => null,
    (e: Error) => e.message,
  );
  const [row] = await db.select().from(s.projects).where(eq(s.projects.domain, String(values.get("domain"))));
  return { row, to };
}

describe.skipIf(!ready)("createProjectFromForm", () => {
  beforeAll(async () => {
    // Generated Google data: its sites and properties are the account's own (src/modules/google/fixtures.ts).
    vi.stubEnv("SEOPEN_GOOGLE_FIXTURES", "1");
    const [ws] = await db.insert(s.workspaces).values({ name: `create-${randomUUID()}`, plan: "internal" }).returning();
    await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 10 });
    state.ws = ws.id;
  });
  beforeEach(() => enqueue.mockClear());

  it("links the properties chosen on the form and starts their sync", async () => {
    const { row, to } = await create(newProject({ gscProperty: "sc-domain:alphanote.example", ga4Property: "properties/1000001" }));
    expect(row.gscProperty).toBe("sc-domain:alphanote.example");
    expect(row.ga4Property).toBe("properties/1000001");
    expect(enqueue.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual(["google.ga4.sync", "google.gsc.sync"]);
    expect(to).toBe(`redirect:/projects/${row.id}`);
  });

  it("links only what was picked", async () => {
    const { row } = await create(newProject({ gscProperty: "sc-domain:alphanote.example", ga4Property: "" }));
    expect(row.gscProperty).toBe("sc-domain:alphanote.example");
    expect(row.ga4Property).toBeNull();
    expect(enqueue.mock.calls.map((c: unknown[]) => c[0])).toEqual(["google.gsc.sync"]);
  });

  it("creates the project with nothing linked when None was left on both", async () => {
    const { row, to } = await create(newProject({ gscProperty: "", ga4Property: "", next: "setup" }));
    expect(row.gscProperty).toBeNull();
    expect(row.ga4Property).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(to).toBe(`redirect:/projects/${row.id}/setup`);
  });

  it("won't link a property that isn't on the account, and still opens the project it created", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { row, to } = await create(newProject({ gscProperty: "sc-domain:someone-elses.example" }));
    expect(row.gscProperty).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(to).toBe(`redirect:/projects/${row.id}`);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("creates no project when the form has a problem, and gives the choices back with what was typed", async () => {
    const result = await createProjectFromForm(null, form({ domain: "not a domain", name: "", locationCode: "2840", languageCode: "en", gscProperty: "sc-domain:alphanote.example" }));
    expect(result?.error).toBeTruthy();
    expect(result?.values?.gscProperty).toBe("sc-domain:alphanote.example");
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe.skipIf(!ready)("Create and audit, on Free", () => {
  /** A Free workspace whose owner has (or hasn't) confirmed their email, made the one the form acts in. */
  async function freeWorkspace(verified = true) {
    const email = `free-${randomUUID().slice(0, 8)}@example.com`;
    const [user] = await db.insert(s.users).values({ id: randomUUID(), email, emailVerified: verified }).returning();
    const [ws] = await db.insert(s.workspaces).values({ name: email, plan: "free" }).returning();
    await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
    state.ws = ws.id;
    return ws;
  }
  const crawlsOf = (projectId: number) => db.select().from(s.auditCrawls).where(eq(s.auditCrawls.projectId, projectId));
  const queued = () => enqueue.mock.calls.map((c: unknown[]) => c[0]);

  beforeEach(() => enqueue.mockClear());

  it.skipIf(!rules.hasPlans)("creates the project and starts its first audit through Start crawl's op, at Free's 100 pages", async () => {
    await freeWorkspace();
    const { row, to } = await create(newProject({ next: "audit" }));
    expect(to).toBe("redirect:/audit");
    const crawls = await crawlsOf(row.id);
    expect(crawls).toHaveLength(1);
    expect(crawls[0]).toMatchObject({ status: "queued", maxPages: 100, enableJavascript: false, trigger: "manual" });
    expect(queued()).toContain("audit.start");
  });

  it("still opens the project it made when the audit is refused, and starts nothing", async () => {
    await freeWorkspace(false);
    const { row, to } = await create(newProject({ next: "audit" }));
    expect(row).toBeDefined();
    expect(to).toBe("redirect:/audit");
    expect(await crawlsOf(row.id)).toEqual([]);
    expect(queued()).not.toContain("audit.start");
  });

  it("starts nothing from Just create it", async () => {
    await freeWorkspace();
    const { row, to } = await create(newProject());
    expect(to).toBe(`redirect:/projects/${row.id}`);
    expect(await crawlsOf(row.id)).toEqual([]);
  });
});

describe.skipIf(!ready)("selectProject", () => {
  beforeEach(async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `select-${randomUUID()}`, plan: "internal" }).returning();
    state.ws = ws.id;
    cookieSet.mockClear();
  });
  const project = async (archived: boolean) =>
    (await db.insert(s.projects).values({ workspaceId: state.ws, name: "p", domain: `${randomUUID().slice(0, 8)}.example`, archived }).returning())[0];

  it("makes a live project the current one", async () => {
    const p = await project(false);
    await selectProject(p.id);
    expect(cookieSet).toHaveBeenCalledWith("seopen_project", String(p.id), expect.anything());
  });

  it("refuses an archived project, as the switcher doesn't list it", async () => {
    const p = await project(true);
    await expect(selectProject(p.id)).rejects.toThrow("not found");
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
