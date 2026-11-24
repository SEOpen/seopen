import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";
import { testDb } from "@/db/test-db";
import { SERP } from "./fixtures";

/**
 * Content briefs against seopen_test: a preview spends nothing, a brief spends only up to
 * maxCredits, saved lookups are free, internal links come from the project's own data, the
 * template rules hold on every save, and another workspace can't read or change one.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/web/fetch", async (original) => ({ ...(await original<typeof import("@/lib/web/fetch")>()), safeFetch: vi.fn() }));

const ready = await testDb();
const { db } = await import("@/db");
const s = await import("@/db/schema");
const { safeFetch } = await import("@/lib/web/fetch");
const { createBriefOp, deleteBrief, getBrief, listBriefs, updateBriefFillOp } = await import("./ops");

const actor = { userId: "u", source: "app" as const };

const task = (result: unknown) => ({ status_code: 20000, tasks_count: 1, tasks_error: 0, cost: 0.002, tasks: [{ status_code: 20000, cost: 0.002, result: [result] }] });
const kw = (keyword: string, volume: number) => ({ keyword, keyword_info: { search_volume: volume, cpc: 1, competition: 0.2, competition_level: "LOW", monthly_searches: [] }, keyword_properties: { keyword_difficulty: 30 }, search_intent_info: { main_intent: "informational" } });

/** DataForSEO, by endpoint. */
function dataforseo() {
  const spy = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.includes("serp/google/organic")) return new Response(JSON.stringify(task(SERP)));
    if (path.includes("keyword_suggestions")) return new Response(JSON.stringify(task({ total_count: 1, items: [kw("when to prune roses", 1600)] })));
    return new Response(JSON.stringify(task({ items: [kw("prune roses", 2400)] })));
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const page = (body: string) => ({ url: "https://www.rhs.example/prune", status: 200, headers: { "content-type": "text/html" }, body, truncated: false, redirects: [], ms: 5 });

describe.runIf(ready)("content briefs", () => {
  let p: typeof s.projects.$inferSelect;
  // DataForSEO's research cache is shared across workspaces and test runs, so each test asks about its own keyword.
  let K: string;
  const scope = () => ({ workspaceId: p.workspaceId, projectId: p.id });

  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => vi.unstubAllEnvs());

  beforeEach(async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal" }).returning();
    await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 10 });
    [p] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Fernhill", domain: "fernhill.example" }).returning();
    await db.insert(s.competitors).values({ workspaceId: ws.id, projectId: p.id, domain: "rival.example" });
    K = `prune roses ${randomUUID().replace(/[^a-f]/g, "").slice(0, 8)}`;
    vi.mocked(safeFetch).mockReset();
    vi.mocked(safeFetch).mockResolvedValue(page("<h2>When to prune</h2><h2>Tools</h2>"));
  });

  it("previews with a price and spends nothing, then needs max_credits at or above it", async () => {
    const fetchSpy = dataforseo();
    const preview = await createBriefOp(scope(), actor, { keyword: K.toUpperCase(), pageType: "guide" }, { dryRun: true });
    expect(preview).toMatchObject({ state: "preview", keyword: K });
    expect(preview.credits).toBeGreaterThan(0);
    const short = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { maxCredits: preview.credits - 1 });
    expect(short).toMatchObject({ state: "needs_credits", credits: preview.credits });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await listBriefs(scope())).toEqual([]);
  });

  it("names the subjects in the preview message instead of the X placeholder", async () => {
    dataforseo();
    const alt = await createBriefOp(scope(), actor, { keyword: `${K} alternatives`, pageType: "alternatives" }, { dryRun: true });
    expect(alt.message).toMatch(new RegExp(`^Would create a ${K} alternatives brief for`));
    expect(alt.message).not.toMatch(/\bX alternatives\b/);
    const guide = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { dryRun: true });
    expect(guide.message).toMatch(/^Would create a Guide brief for/);
  });

  it("creates a brief with every section, then a second one free from the saved lookups", async () => {
    const fetchSpy = dataforseo();
    const { credits } = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide", merged: [`${K} tips`] }, { dryRun: true });
    const made = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide", merged: [`${K} tips`] }, { maxCredits: credits });
    expect(made).toMatchObject({ state: "created", credits });
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    const view = await getBrief(scope(), (made as { id: number }).id);
    expect(view).not.toBeNull();
    const b = view!.brief;
    expect(b.target).toMatchObject({ keyword: K, volume: 2400, source: { label: "Keyword overview, DataForSEO Labs" } });
    expect(b.target.source.at).toBeTruthy();
    expect(b.serp.results.find((r) => r.isProject)?.domain).toBe("fernhill.example");
    expect(b.aiOverview).toMatchObject({ present: true, loaded: true });
    expect(b.questions.paa).toContain("When should roses be pruned?");
    expect(b.top3.pages[0]).toMatchObject({ read: "read", headings: [{ level: 2, text: "When to prune" }, { level: 2, text: "Tools" }] });
    expect(b.ownerInputs.length).toBeGreaterThanOrEqual(3);
    expect(b.internalLinks.note).toContain("no Search Console data");
    // The top 3 pages were asked for, and only them.
    expect(vi.mocked(safeFetch)).toHaveBeenCalledTimes(3);

    const again = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide", merged: [`${K} tips`] }, { dryRun: true });
    expect(again.credits).toBe(0);
    const second = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide", merged: [`${K} tips`] });
    expect(second).toMatchObject({ state: "created", credits: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(await listBriefs(scope())).toHaveLength(2);
  });

  it("says what a failed top 10 left charged, and a retry asks Google again and pays only for it", async () => {
    // Production, Nov 16 2026: 20000 with tasks_error 0 around a SERP task that failed with 40101.
    let serpFails = true;
    const spy = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("serp/google/organic")) {
        if (!serpFails) return new Response(JSON.stringify(task(SERP)));
        return new Response(JSON.stringify({ status_code: 20000, tasks_count: 1, tasks_error: 0, cost: 0, tasks: [{ status_code: 40101, status_message: "Internal SE Server Error.", cost: 0, result: null }] }));
      }
      if (path.includes("keyword_suggestions")) return new Response(JSON.stringify(task({ total_count: 1, items: [kw("when to prune roses", 1600)] })));
      return new Response(JSON.stringify(task({ items: [kw("prune roses", 2400)] })));
    });
    vi.stubGlobal("fetch", spy);
    const { credits } = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { dryRun: true });
    const err = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { maxCredits: credits }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(rules.hasPlans ? /didn't come back\. .*No brief was saved\. The other lookups came back and cost \d+ research credits?; they're saved, so trying again only pays for the one that failed\./ : /didn't come back\. .*No brief was saved\. The other lookups came back and cost \$\d+\.\d\d; they're saved, so trying again only pays for the one that failed\./);
    expect(await listBriefs(scope())).toEqual([]);

    serpFails = false;
    const retry = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { dryRun: true });
    expect(retry.credits).toBeGreaterThan(0);
    expect(retry.credits).toBeLessThan(credits);
    const made = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { maxCredits: retry.credits });
    expect(made).toMatchObject({ state: "created" });
    expect(spy.mock.calls.filter(([u]) => String(u).includes("serp/google/organic"))).toHaveLength(2);
  });

  it("uses a top 10 Keyword research already saved, noting it didn't load a late AI Overview", async () => {
    dataforseo();
    const { load } = await import("@/modules/keywords/dfs");
    const { serpSpec } = await import("@/modules/keywords/requests");
    await load(serpSpec(K, { locationCode: 2840, languageCode: "en" }), { run: true, workspaceId: p.workspaceId });
    const made = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { maxCredits: 100 });
    const view = await getBrief(scope(), (made as { id: number }).id);
    expect(view!.brief.aiOverview.loaded).toBe(false);
  });

  it("suggests internal links from Search Console and the latest crawl", async () => {
    dataforseo();
    for (const date of ["2026-10-01", "2026-10-02"]) {
      await db.insert(s.gscDaily).values({ ...scope(), date, clicks: 1, impressions: 100, ctr: 0.01, position: 9 });
      await db.insert(s.gscQueryPages).values({ ...scope(), date, query: "when to prune roses", page: "https://fernhill.example/roses", clicks: 1, impressions: 100, ctr: 0.01, position: 9 });
    }
    const [crawl] = await db.insert(s.auditCrawls).values({ ...scope(), target: p.domain, maxPages: 10, status: "done", finishedAt: new Date() }).returning();
    await db.insert(s.auditPages).values({ workspaceId: p.workspaceId, crawlId: crawl.id, url: "https://fernhill.example/shop/roses", title: "Buy roses", statusCode: 200, indexable: true, internalLinksIn: 12 });
    const made = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { maxCredits: 100 });
    const links = (await getBrief(scope(), (made as { id: number }).id))!.brief.internalLinks;
    expect(links.from).toEqual([{ url: "https://fernhill.example/roses", why: "Shows for “when to prune roses” at position 9; 200 impressions on the topic.", source: { label: "Search Console, 2026-10-01 to 2026-10-02", at: null } }]);
    expect(links.to.map((l) => l.url)).toEqual(["https://fernhill.example/shop/roses"]);
  });

  it("holds the template rules when created and on every save", async () => {
    dataforseo();
    await expect(createBriefOp(scope(), actor, { keyword: "garden design", pageType: "best" }, { dryRun: true })).rejects.toThrow("Best X for Y page needs");
    await expect(createBriefOp(scope(), actor, { keyword: "site:fernhill.example roses", pageType: "guide" }, { dryRun: true })).rejects.toThrow("leave out operators");
    const four = ["a", "b", "c", "d"].map((name) => ({ name }));
    await expect(createBriefOp(scope(), actor, { keyword: "mailchimp alternatives", pageType: "alternatives", options: four }, { dryRun: true })).rejects.toThrow("5 to 8 options");
    await expect(createBriefOp(scope(), actor, { keyword: "mailchimp alternatives", pageType: "alternatives", options: [{ name: "Fernhill" }, ...four] }, { dryRun: true })).rejects.toThrow("Don't rank your own site first");

    // A vs page takes Y from the tracked competitor.
    const vs = await createBriefOp(scope(), actor, { keyword: "garden planner comparison", pageType: "vs" }, { dryRun: true });
    expect(vs).toMatchObject({ x: "Fernhill", y: "rival.example" });

    const made = await createBriefOp(scope(), actor, { keyword: "mailchimp alternatives", pageType: "alternatives" }, { maxCredits: 100 });
    const id = (made as { id: number }).id;
    const proposed = (await getBrief(scope(), id))!.brief.options;
    expect(proposed[0].name).toBe("rival.example");
    expect(proposed.some((o) => o.name.includes("fernhill"))).toBe(false);

    const five = ["a", "b", "c", "d", "e"].map((name) => ({ name, url: null, price: null, priceCheckedOn: null, drawback: null }));
    await expect(updateBriefFillOp(scope(), id, { options: [{ ...five[0], price: "$9" }, ...five.slice(1)] })).rejects.toThrow("no checked-on date");
    await expect(updateBriefFillOp(scope(), id, { options: five.slice(0, 4) })).rejects.toThrow("5 to 8");
    await updateBriefFillOp(scope(), id, { options: [{ ...five[0], price: "$9", priceCheckedOn: "2026-11-01" }, ...five.slice(1)], angle: "Nobody tests deliverability", inputs: { numbers: "Our open rate", nope: "ignored" } });
    const filled = (await getBrief(scope(), id))!.fill;
    expect(filled).toEqual({ angle: "Nobody tests deliverability", inputs: { numbers: "Our open rate" }, options: [{ ...five[0], price: "$9", priceCheckedOn: "2026-11-01" }, ...five.slice(1)] });
  });

  it("keeps another workspace out", async () => {
    dataforseo();
    const made = await createBriefOp(scope(), actor, { keyword: K, pageType: "guide" }, { maxCredits: 100 });
    const id = (made as { id: number }).id;
    const [other] = await db.insert(s.workspaces).values({ name: `w-${randomUUID()}`, plan: "internal" }).returning();
    const [op] = await db.insert(s.projects).values({ workspaceId: other.id, name: "Other", domain: "other.example" }).returning();
    const B = { workspaceId: other.id, projectId: op.id };
    expect(await getBrief(B, id)).toBeNull();
    expect(await getBrief({ workspaceId: other.id, projectId: p.id }, id)).toBeNull();
    expect(await listBriefs(B)).toEqual([]);
    await expect(updateBriefFillOp(B, id, { angle: "x" })).rejects.toThrow("no such brief");
    expect(await deleteBrief(B, id)).toBe(false);
    expect(await db.select().from(s.contentBriefs).where(eq(s.contentBriefs.id, id))).toHaveLength(1);
    expect(await deleteBrief(scope(), id)).toBe(true);
  });
});
