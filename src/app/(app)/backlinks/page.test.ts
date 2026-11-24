import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";

const getSummary = vi.hoisted(() => vi.fn());
const getNewLost = vi.hoisted(() => vi.fn());
const spend = vi.hoisted(() => ({ free: false }));
const request = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("next/navigation", () => ({ usePathname: () => "/backlinks", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/workspace/current", () => ({ workspaceScope: async () => ({ workspaceId: 7 }), currentWorkspace: async () => ({ id: 7 }), currentTimeZone: async () => "UTC" }));
vi.mock("@/lib/billing/spend", () => ({ spendState: async () => ({ refusal: null, workspace: { plan: spend.free ? "free" : "starter" } }) }));
vi.mock("@/modules/backlinks/api", async (original) => ({ ...(await original<typeof import("@/modules/backlinks/api")>()), getSummary, getNewLost }));
vi.mock("@/modules/backlinks/header", async (original) => ({
  ...(await original<typeof import("@/modules/backlinks/header")>()),
  resolveTarget: async () => ({ target: "example.org", invalid: null, project: null, isProjectDomain: false, workspaceId: 7 }),
  spendRefusal: async () => undefined,
  onFreePlan: async () => spend.free,
}));

const { default: BacklinksPage } = await import("./page");

const open = () => BacklinksPage({ params: Promise.resolve({}), searchParams: Promise.resolve({ q: "example.org", run: "1" }) } as Parameters<typeof BacklinksPage>[0]);
/** The overview element the page hands to Suspense. */
const overview = (page: ReactElement) => (page.props as { children: ReactElement<{ run: boolean }> }).children;
/** Renders that overview, an async server component, the way React would. */
async function render(page: ReactElement) {
  const el = overview(page);
  const Overview = el.type as (props: typeof el.props) => Promise<ReactElement>;
  return renderToStaticMarkup(await Overview(el.props));
}

beforeEach(() => {
  // Not cached, so only a call allowed to spend gets past pending; on Free that call is refused.
  for (const fn of [getSummary, getNewLost]) {
    fn.mockReset();
    fn.mockImplementation(async (_target: string, opts: { run?: boolean }) => {
      if (!opts.run) return { pending: true, estimateUsd: 0.02 };
      if (spend.free) throw new Error("Backlinks aren't part of the Free plan.");
      return { data: null, meta: {} };
    });
  }
  spend.free = false;
  request.headers = new Headers({ "sec-fetch-site": "same-origin" });
});

describe("run=1 on the Free plan", () => {
  it("never hands the overview leave to spend, even from SEOpen's own Run link", async () => {
    spend.free = true;
    expect(overview(await open()).props.run).toBe(false);
  });

  it.skipIf(!rules.hasPlans)("shows what Starter adds instead of a refusal", async () => {
    spend.free = true;
    const html = await render(await open());
    expect(html).toContain("Backlinks are on Starter");
    expect(html).toMatch(/href="\/billing"/);
    expect(html).not.toContain("Free plan.");
    for (const fn of [getSummary, getNewLost]) expect(fn).toHaveBeenCalledWith("example.org", expect.objectContaining({ run: false }));
  });
});

describe("run=1 on a paid plan", () => {
  it("spends from SEOpen's own Run button, as before", async () => {
    expect(overview(await open()).props.run).toBe(true);
  });

  it("doesn't spend from another site", async () => {
    request.headers = new Headers({ "sec-fetch-site": "cross-site" });
    expect(overview(await open()).props.run).toBe(false);
  });
});
