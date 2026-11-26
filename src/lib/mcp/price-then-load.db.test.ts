import { randomBytes, randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * A lookup is priced, then run, and a saved answer can expire between the two: it is read by the
 * clock each time. Against seopen_test with DataForSEO stubbed, the hooks below expire the saved
 * answer right after the price was worked out. A lookup priced at nothing must then buy nothing,
 * whatever key asked: it quotes the price instead.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));

const hook: { afterPrice: null | (() => Promise<void>); afterLocalQuote: null | (() => Promise<void>) } = { afterPrice: null, afterLocalQuote: null };

vi.mock("@/modules/keywords/dfs", async (original) => {
  const real = await original<typeof import("@/modules/keywords/dfs")>();
  return {
    ...real,
    pendingSpecs: async (...args: Parameters<typeof real.pendingSpecs>) => {
      const unpaid = await real.pendingSpecs(...args);
      if (hook.afterPrice) await hook.afterPrice();
      return unpaid;
    },
  };
});
vi.mock("@/modules/local/ops", async (original) => {
  const real = await original<typeof import("@/modules/local/ops")>();
  return {
    ...real,
    findListingsOp: async (...args: Parameters<typeof real.findListingsOp>) => {
      const out = await real.findListingsOp(...args);
      if (args[2]?.dryRun && hook.afterLocalQuote) await hook.afterLocalQuote();
      return out;
    },
  };
});

const ready = await testDb();
const { db } = await import("@/db");
const s = await import("@/db/schema");
const keys = await import("./keys");
const { POST, GET } = await import("@/app/api/mcp/route");
const { SEARCH_NOT_SAVED } = await import("@/modules/local/ops");

const URL_ = "http://127.0.0.1:4100/api/mcp";

async function seedWorkspace(tag: string) {
  const [user] = await db.insert(s.users).values({ id: `u-${randomUUID()}`, email: `${tag}-${randomUUID()}@example.com`, emailVerified: true }).returning();
  const [ws] = await db.insert(s.workspaces).values({ name: `${tag}-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id });
  await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 10 });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: `${tag} site`, domain: `${tag}-${ws.id}.example` }).returning();
  return { user, ws, project };
}

const routeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(input, init);
  return req.method === "POST" ? POST(req) : GET();
};
const clients: Client[] = [];
async function connect(key: string) {
  const client = new Client({ name: "seopen-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: routeFetch, authProvider: { token: async () => key } }));
  clients.push(client);
  return client;
}
type ToolOut = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolOut;

const run = randomUUID().slice(0, 8);
const WORD = `price widgets ${run}`;
const RESPONSE = {
  status_code: 20000,
  status_message: "Ok.",
  cost: 0.01,
  tasks_count: 1,
  tasks_error: 0,
  tasks: [{ status_code: 20000, result: [{ items: [{ keyword: WORD, keyword_info: { search_volume: 1200, cpc: 1.5, competition: 0.4, monthly_searches: [] }, keyword_properties: { keyword_difficulty: 33 }, search_intent_info: { main_intent: "commercial" } }] }] }],
};
const dataforseo = (body: object = RESPONSE) => {
  const spy = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal("fetch", spy);
  return spy;
};
const ledger = (workspaceId: number) => db.select().from(s.apiLedger).where(eq(s.apiLedger.workspaceId, workspaceId));
/** Moves the expiry of every saved answer this workspace paid for into the past: the TTL running out. */
const expireSaved = async (workspaceId: number) => {
  const paid = await db.select({ key: s.apiCacheAccess.key }).from(s.apiCacheAccess).where(eq(s.apiCacheAccess.workspaceId, workspaceId));
  if (paid.length) await db.update(s.apiCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(inArray(s.apiCache.key, paid.map((p) => p.key)));
  // Per-workspace keys (Maps search) carry no access row.
  await db.update(s.apiCache).set({ expiresAt: new Date(Date.now() - 1000) }).where(sql`${s.apiCache.key} like ${`w${workspaceId}:%`}`);
};
const revive = (workspaceId: number) =>
  db
    .update(s.apiCache)
    .set({ expiresAt: new Date(Date.now() + 60_000) })
    .where(sql`${s.apiCache.key} in (select key from api_cache_access where workspace_id = ${workspaceId}) or ${s.apiCache.key} like ${`w${workspaceId}:%`}`);

describe.skipIf(!ready)("a saved answer that expires between the price and the lookup", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => {
    hook.afterPrice = null;
    hook.afterLocalQuote = null;
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    vi.unstubAllEnvs();
  });

  it("keyword_overview quotes it and buys nothing, for a key that can't spend and for one that can", async () => {
    const W = await seedWorkspace("pricekw");
    const readKey = (await keys.createApiKey({ workspaceId: W.ws.id, userId: W.user.id }, { name: "read only" })).key;
    const researchKey = (await keys.createApiKey({ workspaceId: W.ws.id, userId: W.user.id }, { name: "research", research: true })).key;
    const fetchSpy = dataforseo();

    // The research key buys the lookup once, with approval.
    const researcher = await connect(researchKey);
    const { credits } = (await call(researcher, "keyword_overview", { keyword: WORD })).structuredContent!;
    await call(researcher, "keyword_overview", { keyword: WORD, max_credits: credits });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await ledger(W.ws.id)).toHaveLength(1);

    // Saved, so free for a key that can't spend.
    const reader = await connect(readKey);
    expect((await call(reader, "keyword_overview", { keyword: WORD })).structuredContent).toMatchObject({ cached: true, credits: 0, credits_charged: 0 });

    for (const [client, args] of [
      [reader, {}],
      [reader, { max_credits: 1000 }],
      // No max_credits: this key may spend, but nobody approved a price for this call.
      [researcher, {}],
    ] as const) {
      await revive(W.ws.id);
      hook.afterPrice = () => expireSaved(W.ws.id);
      const raced = (await call(client, "keyword_overview", { keyword: WORD, ...args })).structuredContent!;
      hook.afterPrice = null;
      expect(raced).toMatchObject({ needs_approval: true, credits });
      expect(raced).not.toHaveProperty("volume");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await ledger(W.ws.id)).toHaveLength(1);
  });

  it("a content brief asks for the price of a lookup that has gone, and buys nothing", async () => {
    const { createBriefOp } = await import("@/modules/content-briefs/ops");
    const W = await seedWorkspace("pricebrief");
    const scope = { workspaceId: W.ws.id, projectId: W.project.id };
    const actor = { userId: W.user.id, source: "mcp" as const };
    const input = { keyword: `prune roses ${run}`, pageType: "guide" as const };
    const fetchSpy = dataforseo();

    // Bought once, at the price shown.
    const quote = await createBriefOp(scope, actor, input, { dryRun: true });
    expect(quote).toMatchObject({ state: "preview" });
    const credits = (quote as { credits: number }).credits;
    expect(credits).toBeGreaterThan(0);
    expect(await createBriefOp(scope, actor, input, { maxCredits: credits })).toMatchObject({ state: "created" });
    const bought = fetchSpy.mock.calls.length;
    const rows = (await ledger(W.ws.id)).length;

    // Every lookup is saved now, so the next brief is priced at nothing. They expire after that price.
    expect(await createBriefOp(scope, actor, input, { dryRun: true })).toMatchObject({ state: "preview", credits: 0 });
    for (const maxCredits of [0, 1000]) {
      await revive(W.ws.id);
      hook.afterPrice = () => expireSaved(W.ws.id);
      const raced = await createBriefOp(scope, actor, input, { maxCredits });
      hook.afterPrice = null;
      expect(raced.state).toBe("needs_credits");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(bought);
    expect(await ledger(W.ws.id)).toHaveLength(rows);
  });

  it("find_local_listing reads the saved search or says it isn't saved, and buys nothing", async () => {
    const W = await seedWorkspace("pricelocal");
    const writeKey = (await keys.createApiKey({ workspaceId: W.ws.id, userId: W.user.id }, { name: "writer", write: true })).key;
    const spendKey = (await keys.createApiKey({ workspaceId: W.ws.id, userId: W.user.id }, { name: "spender", write: true, research: true })).key;
    const fetchSpy = dataforseo({ ...RESPONSE, tasks: [{ status_code: 20000, result: [{ items: [{ type: "maps_search", title: "Ours", cid: "1", latitude: 32.7, longitude: -79.9, domain: null, rank_group: 1 }] }] }] });
    const args = { project: W.project.id, name: `Widget Shop ${run}`, city: "Salem" };

    const spender = await connect(spendKey);
    const quote = (await call(spender, "find_local_listing", args)).structuredContent!;
    await call(spender, "find_local_listing", { ...args, max_credits: (quote.price as { credits: number }).credits });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await ledger(W.ws.id)).toHaveLength(1);

    // Saved: free for a key that can't spend, read from the saved search.
    const writer = await connect(writeKey);
    const saved = await call(writer, "find_local_listing", args);
    expect(saved.isError).toBeFalsy();
    expect(JSON.stringify(saved.structuredContent)).toContain("Ours");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    for (const client of [writer, spender]) {
      await revive(W.ws.id);
      hook.afterLocalQuote = () => expireSaved(W.ws.id);
      const raced = await call(client, "find_local_listing", args);
      hook.afterLocalQuote = null;
      expect(raced.isError).toBe(true);
      expect(raced.content[0].text).toContain(SEARCH_NOT_SAVED);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await ledger(W.ws.id)).toHaveLength(1);
  });
});
