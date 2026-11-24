import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import { rules } from "@/plan-policy/rules";

/**
 * spendState is cached per request, against seopen_test. Tests run outside a React render, so React's
 * own server `cache` is swapped in and given a stand-in request: a fresh cache store per request, as
 * React makes one per render. Outside a request (a server action, a route, a job) it reads fresh.
 */

type Dispatcher = { getCacheForType: <T>(create: () => T) => T } | null;
type ReactServer = { cache: typeof import("react").cache; __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { A: Dispatcher } };

/** React's server build, the one Next renders with. Loaded by path, since only the react-server condition exports it. */
const reactServer = vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const require = createRequire(import.meta.url);
  return require(join(dirname(require.resolve("react/package.json")), "react.react-server.js")) as ReactServer;
});

vi.mock("server-only", () => ({}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: (await reactServer).cache }));

const internals = (await reactServer).__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/** Runs `fn` as one request: every cached call inside it shares one store. */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  const store = new Map<unknown, unknown>();
  internals.A = {
    getCacheForType: <C,>(create: () => C) => {
      if (!store.has(create)) store.set(create, create());
      return store.get(create) as C;
    },
  };
  try {
    return await fn();
  } finally {
    internals.A = null;
  }
}

const ready = await testDb();

const { db } = await import("@/db");
const { users, workspaceMembers, workspaces, workspaceSettings } = await import("@/db/schema");
const { reserveSpend, spendBlock, spendState, usageSummary } = await import("./spend");

/** A Starter workspace with a verified owner and its own cap. */
async function workspace(capUsd: number) {
  const email = `spend-cache-${randomUUID().slice(0, 8)}@example.com`;
  const [user] = await db.insert(users).values({ id: randomUUID(), email, emailVerified: true }).returning();
  const [ws] = await db.insert(workspaces).values({ name: email, plan: "starter" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  await db.insert(workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: capUsd });
  return ws.id;
}

afterEach(() => {
  internals.A = null;
  vi.restoreAllMocks();
});

describe.skipIf(!ready)("spendState per request", () => {
  it.skipIf(!rules.hasPlans)("returns the same numbers in a request as outside one", async () => {
    const id = await workspace(7);
    const fresh = await spendState(id);
    expect(fresh).toMatchObject({ ceilingUsd: 7, refusal: null, workspace: { id, plan: "starter", status: "active" } });
    expect(await inRequest(() => spendState(id))).toEqual(fresh);
  });

  it.skipIf(!rules.hasPlans)("reads once for two calls in one request, through spendBlock and usageSummary too", async () => {
    const id = await workspace(7);
    const select = vi.spyOn(db, "select");
    const [a, b] = await inRequest(() => Promise.all([spendState(id), spendState(id)]));
    expect(b).toBe(a);
    const once = select.mock.calls.length;
    // The workspace row, the platform cap and the owner's email check.
    expect(once).toBe(3);

    select.mockClear();
    await inRequest(async () => {
      await spendState(id);
      const afterFirst = select.mock.calls.length;
      await Promise.all([spendBlock(id), usageSummary(id)]);
      // The month's usage is read with db.execute, so any new select here would be spendState again.
      expect(select.mock.calls.length - afterFirst).toBe(0);
    });
  });

  it("never gives one workspace another's value", async () => {
    const [a, b] = [await workspace(7), await workspace(11)];
    const [sa, sb, sa2] = await inRequest(() => Promise.all([spendState(a), spendState(b), spendState(a)]));
    expect(sa.workspace.id).toBe(a);
    expect(sa.ceilingUsd).toBe(7);
    expect(sb.workspace.id).toBe(b);
    expect(sb.ceilingUsd).toBe(11);
    expect(sa2).toBe(sa);
  });

  it.skipIf(!rules.hasPlans)("reads again in the next request and outside any request", async () => {
    const id = await workspace(7);
    expect((await inRequest(() => spendState(id))).ceilingUsd).toBe(7);
    await db.update(workspaceSettings).set({ monthlyCapUsd: 9 }).where(eq(workspaceSettings.workspaceId, id));
    expect((await inRequest(() => spendState(id))).ceilingUsd).toBe(9);
    const select = vi.spyOn(db, "select");
    await spendState(id);
    await spendState(id);
    expect(select.mock.calls.length).toBe(6);
  });

  it.skipIf(!rules.hasPlans)("reserves against a fresh read, even after a cached one in the same request", async () => {
    const id = await workspace(7);
    await inRequest(async () => {
      expect((await spendState(id)).refusal).toBeNull();
      await db.update(workspaces).set({ status: "suspended" }).where(eq(workspaces.id, id));
      await expect(reserveSpend(id, 0.01, false, "rank")).rejects.toMatchObject({ code: "suspended" });
    });
  });
});
