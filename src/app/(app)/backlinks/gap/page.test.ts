import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";

const getCompetitorGap = vi.hoisted(() => vi.fn());
const spend = vi.hoisted(() => ({ refused: undefined as string | undefined, free: false }));
const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("next/navigation", () => ({ usePathname: () => "/backlinks/gap", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/workspace/current", () => ({ workspaceScope: async () => ({ workspaceId: 7 }), currentWorkspace: async () => ({ id: 7 }), currentTimeZone: async () => "UTC" }));
vi.mock("@/modules/backlinks/api", async (original) => ({ ...(await original<typeof import("@/modules/backlinks/api")>()), getCompetitorGap }));
vi.mock("@/modules/backlinks/header", async (original) => ({
  ...(await original<typeof import("@/modules/backlinks/header")>()),
  resolveTarget: async () => ({ target: "me.com", invalid: null, project: null, isProjectDomain: false, workspaceId: 7 }),
  spendRefusal: async () => spend.refused,
  onFreePlan: async () => spend.free,
}));

const { default: GapPage } = await import("./page");

const open = (vs: string) => GapPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ q: "me.com", run: "1", vs }) } as Parameters<typeof GapPage>[0]);
/** The competitors the page goes on to look up, read off the element it hands to Suspense. */
const lookedUp = (page: ReactElement) => (page.props as { children: ReactElement<{ competitors: string[] }> }).children.props.competitors;
/** Whether the page hands its lookup leave to spend. */
const runs = (page: ReactElement) => (page.props as { children: ReactElement<{ run: boolean }> }).children.props.run;

beforeEach(() => {
  getCompetitorGap.mockClear();
  spend.refused = undefined;
  spend.free = false;
  request.headers = new Headers();
});

describe("on the Free plan", () => {
  it.skipIf(!rules.hasPlans)("says what Starter adds instead of offering Compare", async () => {
    spend.free = true;
    const html = renderToStaticMarkup(await open("not a domain"));
    expect(html).toContain("Backlinks are on Starter");
    expect(html).toMatch(/href="\/billing"/);
    expect(html).not.toContain("Compare");
    expect(html).not.toContain('name="run"');
    expect(getCompetitorGap).not.toHaveBeenCalled();
  });

  it("never hands the lookup leave to spend, even from SEOpen's own Run link", async () => {
    spend.free = true;
    request.headers = new Headers({ "sec-fetch-site": "same-origin" });
    expect(runs(await open("rival.com"))).toBe(false);
  });
});

describe("run=1 from another site", () => {
  it("doesn't spend: the page shows as if run weren't there", async () => {
    request.headers = new Headers({ "sec-fetch-site": "cross-site" });
    expect(runs(await open("rival.com"))).toBe(false);
  });

  it("spends from SEOpen's own Run button, as before", async () => {
    request.headers = new Headers({ "sec-fetch-site": "same-origin" });
    expect(runs(await open("rival.com"))).toBe(true);
  });
});

describe("link gap competitors", () => {
  it("shows the no-competitors state and spends nothing when nothing typed is a domain", async () => {
    const html = renderToStaticMarkup(await open("not a domain"));
    expect(html).toContain("No competitors to compare");
    expect(getCompetitorGap).not.toHaveBeenCalled();
  });

  it("looks up only the hostnames, once each, and never the target", async () => {
    expect(lookedUp(await open("not a domain, https://www.rival.com/page rival.com me.com other.co.uk"))).toEqual(["rival.com", "other.co.uk"]);
  });

  it("stops at five", async () => {
    expect(lookedUp(await open("a.com b.com c.com d.com e.com f.com"))).toEqual(["a.com", "b.com", "c.com", "d.com", "e.com"]);
  });
});

describe("the link gap table", () => {
  const row = (target: string, rank: number, spam: number) => ({ domain_intersection: { "1": { target, rank, backlinks: 3, backlinks_spam_score: spam, first_seen: "2024-01-01" } } });
  /** The page as Gap renders it, with every competitor answered from these rows. */
  const render = async (vs: string, items: ReturnType<typeof row>[]) => {
    getCompetitorGap.mockResolvedValue({ data: items, total: items.length, meta: { cached: true, costUsd: 0, estimateUsd: 0.1, fetchedAt: null } });
    const gap = (await open(vs)).props.children as ReactElement;
    return renderToStaticMarkup((await (gap.type as (p: unknown) => Promise<ReactElement>)(gap.props)) as ReactElement);
  };
  const order = (html: string, domains: string[]) => domains.map((d) => html.indexOf(`>${d}</a>`));

  it("lists the niche sites first, general hosts after them with a note, and spam last", async () => {
    const html = await render("rival-one.example rival-two.example rival-three.example", [row("news-hub.example", 700, 0), row("farm.example", 650, 70), row("garden-blog.example", 120, 1)]);
    const [blog, hub, farm] = order(html, ["garden-blog.example", "news-hub.example", "farm.example"]);
    expect(blog).toBeGreaterThan(-1);
    expect(blog).toBeLessThan(hub);
    expect(hub).toBeLessThan(farm);
    // The note is on the general host and the spam row, which links to every competitor at a high rank too.
    expect(html.match(/Links to every competitor/g)).toHaveLength(2);
    expect(html).toContain("sites that link to every competitor after them");
  });

  it("leaves out universal linkers and the competitors' own sites, and names them under the table", async () => {
    const html = await render("rival-one.example", [row("google.de", 900, 0), row("rival-one.ru", 300, 0), row("garden-blog.example", 120, 1)]);
    expect(html).not.toContain(">google.de</a>");
    expect(html).not.toContain(">rival-one.ru</a>");
    expect(html).toContain("Not shown: google.de, which links to nearly every site; rival-one.ru, a competitor&#x27;s own site.");
    // One competitor: nothing can link to every one of them in a way that means anything, so no Note column.
    expect(html).not.toContain("Links to every competitor");
  });
});

describe("Compare while the workspace can't spend", () => {
  it("is off and says why on the button", async () => {
    spend.refused = "This workspace is suspended.";
    const html = renderToStaticMarkup(await open("not a domain"));
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."[^>]*>.*Compare/);
  });

  it("is on otherwise", async () => {
    const html = renderToStaticMarkup(await open("not a domain"));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>.*Compare/);
    expect(html).not.toMatch(/<button[^>]*\bdisabled=""/);
  });
});
