import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * Posting a Local check against seopen_test, with DataForSEO faked. Each point keeps the task id
 * it was given, a point whose task was refused fails with its own reason, a task tagged for
 * another check is ignored, and a tag naming another workspace's point writes nothing there.
 */

vi.mock("server-only", () => ({}));

const PREFIX = randomUUID();
let nextId = 0;
/** Point id to the refusal its next task gets, used once. Points not here are accepted. */
const refuse = new Map<number, string>();
/** Extra tasks the fake answers with, as if DataForSEO echoed tags we didn't send. */
let extra: string[] = [];
/** Every task the fake answered, in order. */
const answered: { tag: string; id: string; status_code: number; status_message: string }[] = [];
let calls = 0;

vi.mock("@/lib/dataforseo/client", () => ({
  dfsGet: vi.fn(async () => {
    throw new Error("no fetch expected");
  }),
  dfsPost: vi.fn(async (_path: string, tasks: { tag: string }[]) => {
    calls++;
    const out = [...tasks.map((t) => t.tag), ...extra].map((tag) => {
      const pointId = Number(tag.split(":")[2]);
      const why = refuse.get(pointId);
      refuse.delete(pointId);
      const [code, ...message] = (why ?? "20100 Task Created.").split(" ");
      const task = { tag, id: `${PREFIX}-${++nextId}`, status_code: Number(code), status_message: message.join(" ") };
      answered.push(task);
      return { id: task.id, status_code: task.status_code, status_message: task.status_message, data: { tag } };
    });
    extra = [];
    return { cost: tasks.length * 0.0006, tasks: out };
  }),
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { asc, eq } = await import("drizzle-orm");
const { createCheck, postCheck } = await import("./tracker");
const { makeTag } = await import("./parse");

async function seed(keywords: string[], gridSize = 3) {
  const [ws] = await db.insert(s.workspaces).values({ name: `local-post-${randomUUID()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Shop", domain: `shop-${ws.id}.example` }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  return { scope, ...(await business(scope, keywords, gridSize)) };
}

async function business(scope: { workspaceId: number; projectId: number }, keywords: string[], gridSize = 3) {
  const [b] = await db
    .insert(s.localBusinesses)
    .values({ ...scope, query: "Shop", city: "Salem, NH", title: "Shop", cid: randomUUID(), lat: 42.79, lng: -71.2, gridSize, radiusMiles: 2 })
    .returning();
  await db.insert(s.localKeywords).values(keywords.map((keyword) => ({ workspaceId: scope.workspaceId, businessId: b.id, keyword })));
  const check = (await createCheck(scope, b, "manual"))!;
  return { business: b, check };
}

const pointsOf = (checkId: number) => db.select().from(s.localPoints).where(eq(s.localPoints.checkId, checkId)).orderBy(asc(s.localPoints.id));
const checkOf = async (checkId: number) => (await db.select().from(s.localChecks).where(eq(s.localChecks.id, checkId)))[0];

describe.skipIf(!ready)("postCheck", () => {
  beforeEach(() => {
    refuse.clear();
    extra = [];
    answered.length = 0;
    calls = 0;
  });

  it("each posted point keeps its own task id, and each refused one fails with its own reason", async () => {
    // 5 keywords on a 5 by 5 grid: 125 points, two posts of up to 100.
    const x = await seed(["coffee", "espresso", "latte", "mocha", "tea"], 5);
    const before = await pointsOf(x.check.id);
    expect(before).toHaveLength(125);
    refuse.set(before[3].id, "40501 Invalid Field: 'keyword'.");
    refuse.set(before[110].id, "40202 Rate limit.");
    const refused = new Map(refuse);
    const started = Date.now();

    await postCheck(x.scope, x.check.id);

    expect(calls).toBe(2);
    const taskFor = new Map(answered.map((a) => [Number(a.tag.split(":")[2]), a.id]));
    for (const p of await pointsOf(x.check.id)) {
      const why = refused.get(p.id);
      if (why) {
        expect(p).toMatchObject({ status: "failed", error: why, taskId: null, postedAt: null });
        expect(p.fetchedAt!.getTime()).toBeGreaterThanOrEqual(started - 1000);
      } else {
        expect(p).toMatchObject({ status: "pending", error: null, taskId: taskFor.get(p.id), fetchedAt: null });
        expect(p.postedAt!.getTime()).toBeGreaterThanOrEqual(started - 1000);
      }
    }
    // The check goes on to be polled, and keeps the last refusal, in the order they came back, as its error.
    const last = answered.filter((a) => a.status_code !== 20100).at(-1)!;
    expect(await checkOf(x.check.id)).toMatchObject({ status: "pending", error: `${last.status_code} ${last.status_message}`, tasksFailed: 2 });
  });

  it("a check whose every task was refused has failed", async () => {
    const x = await seed(["coffee"], 1);
    const [only] = await pointsOf(x.check.id);
    refuse.set(only.id, "40501 Invalid Field: 'keyword'.");

    await postCheck(x.scope, x.check.id);

    expect((await pointsOf(x.check.id))[0]).toMatchObject({ status: "failed", error: "40501 Invalid Field: 'keyword'.", taskId: null });
    expect(await checkOf(x.check.id)).toMatchObject({ status: "failed", error: "40501 Invalid Field: 'keyword'." });
  });

  it("ignores a task tagged for another check, and never writes another workspace's point", async () => {
    const x = await seed(["coffee"], 1);
    const sibling = await business(x.scope, ["coffee"], 1);
    const other = await seed(["coffee"], 1);
    const [siblingPoint] = await pointsOf(sibling.check.id);
    const [otherPoint] = await pointsOf(other.check.id);
    // The first echo of the other workspace's point is refused and the second accepted, so each kind of write is tried.
    extra = [makeTag(sibling.check.id, siblingPoint.id), makeTag(x.check.id, otherPoint.id), makeTag(x.check.id, otherPoint.id)];
    refuse.set(otherPoint.id, "40501 Invalid Field: 'keyword'.");

    await postCheck(x.scope, x.check.id);

    expect((await pointsOf(x.check.id))[0]).toMatchObject({ status: "pending" });
    expect((await pointsOf(x.check.id))[0].taskId).toBeTruthy();
    for (const untouched of [siblingPoint, otherPoint]) {
      const [now] = await db.select().from(s.localPoints).where(eq(s.localPoints.id, untouched.id));
      expect(now).toEqual(untouched);
    }
  });
});
