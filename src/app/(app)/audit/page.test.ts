import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_PLAN_REFUSAL } from "@/lib/billing/spend";
import type { Refusal } from "@/lib/billing/errors";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { Briefing } from "@/components/ui/briefing";
import { CRAWL_CANCELLED } from "@/lib/dataforseo/failure-copy";
import { CrawlForm } from "@/modules/audit/components/crawl-form";
import { FixesNext } from "@/modules/audit/components/bits";
import { SiteWideNotices } from "@/modules/audit/components/site-wide-notices";
import { rules } from "@/plan-policy/rules";

const history = vi.hoisted(() => ({ current: [] as unknown[] }));
const refusal = vi.hoisted(() => ({ current: null as Refusal | null }));
const finished = vi.hoisted(() => ({ current: null as unknown }));
const openFixes = vi.hoisted(() => ({ current: 0 }));
const MISSING_TITLE = { code: "missing-title", title: "Missing title", category: "content", severity: "error", count: 3, added: 0, fixed: 0 };
const summaryRows = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/audit", useRouter: () => ({ refresh() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/projects", async (original) => ({ ...(await original<typeof import("@/lib/projects")>()), getCurrentProject: async () => ({ id: 1, workspaceId: 7, name: "p", domain: "example.com" }) }));
vi.mock("@/lib/workspace/current", async (original) => ({ ...(await original<typeof import("@/lib/workspace/current")>()), currentTimeZone: async () => "UTC", currentWorkspace: async () => ({ id: 7, plan: "starter" }) }));
vi.mock("@/lib/billing/check-gate", () => ({ checkGate: async () => () => refusal.current }));
// Workspace 7 is whatever another test left in seopen_test, so the spend banner's state is fixed here: nothing refused.
vi.mock("@/lib/billing/spend", async (original) => ({ ...(await original<typeof import("@/lib/billing/spend")>()), spendState: async () => ({ refusal: null }) }));
vi.mock("@/modules/audit/crawl", async (original) => ({ ...(await original<typeof import("@/modules/audit/crawl")>()), activeCrawl: async () => null, getSettings: async () => ({ maxPages: 100, weekly: false }) }));
vi.mock("@/modules/audit/queries", async (original) => ({
  ...(await original<typeof import("@/modules/audit/queries")>()),
  resolveCrawl: async () => ({ crawl: finished.current, previous: null, all: finished.current ? [finished.current] : [] }),
  issueSummary: async () => ({ rows: summaryRows.current, newUrls: 0, fixedUrls: 0 }),
  statusBreakdown: async () => ({}),
  listCrawls: async () => history.current,
  latestLighthouse: async () => null,
}));

vi.mock("@/modules/fixes/queries", () => ({ fixCounts: async () => ({ open: openFixes.current, applied: 0, live: 0, measured: 0, resolved: 0, dismissed: 0 }) }));

const { default: AuditPage } = await import("./page");

/** Every element of a kind in what the page returned, without rendering its async children. */
function find<P>(node: ReactNode, type: unknown, out: ReactElement<P>[] = []): ReactElement<P>[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, type, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === type) out.push(el as unknown as ReactElement<P>);
    find(el.props.children, type, out);
  }
  return out;
}

const crawl = (error: string | null) => ({ id: 1, status: "failed", error, trigger: "manual", createdAt: new Date("2026-11-07T10:00:00Z"), pagesCrawled: 0, healthScore: null, errors: 0, warnings: 0, costUsd: 0 });
const open = async () => (await AuditPage()) as ReactElement;
const callouts = (page: ReactElement) => find<{ title: string; reason: string; again?: string | null; link?: { href: string } | null }>(page, CheckFailureCallout);
const sentence = (page: ReactElement) => find<{ sentence: string }>(page, Briefing)[0].props.sentence;

beforeEach(() => {
  refusal.current = null;
  finished.current = null;
  openFixes.current = 0;
  summaryRows.current = [MISSING_TITLE];
});

describe("/audit and Overview agree about a crawl", () => {
  it("doesn't call a cancelled crawl a failure", async () => {
    history.current = [crawl(CRAWL_CANCELLED)];
    const page = await open();
    expect(callouts(page)).toEqual([]);
    expect(sentence(page)).not.toMatch(/failed/);
  });

  it("calls a failed one a failure, and offers another", async () => {
    history.current = [crawl("Timed out")];
    const page = await open();
    expect(callouts(page)[0].props.title).toMatch(/^Last crawl failed/);
    expect(callouts(page)[0].props.link?.href).toBe("#new-crawl");
    expect(sentence(page)).toMatch(/failed/);
  });

  it.skipIf(!rules.hasPlans)("doesn't offer another when the workspace can't start one", async () => {
    history.current = [crawl("Timed out")];
    refusal.current = FREE_PLAN_REFUSAL;
    const { props } = callouts(await open())[0];
    expect(props.link?.href).toBe("/billing");
    expect(props.again).toBe(FREE_PLAN_REFUSAL.message);
    expect(props.reason).not.toMatch(/start a new one|run it again/i);
  });
});

describe("/audit's New crawl form", () => {
  const form = (page: ReactElement) => find<{ disabledReason?: string | null }>(page, CrawlForm)[0].props;

  it("says this week's Free audit is used before Start crawl is clicked, not after", async () => {
    history.current = [];
    refusal.current = { code: "free_audit", upgradable: false, message: "The Free plan includes one site audit a week, and this week's has been used." };
    expect(form(await open()).disabledReason).toBe(refusal.current.message);
  });

  it("is on when nothing refuses it", async () => {
    history.current = [];
    expect(form(await open()).disabledReason).toBeFalsy();
  });

  // Before any results Start crawl runs on one click, as it did for the first crawl, whatever the last one died of.
  it.each(["Timed out", "50000 Internal Error.", "40501 Invalid Field"])("starts on one click with no results yet, after a crawl that failed with %s", async (error) => {
    history.current = [crawl(error)];
    expect(find<{ first: boolean }>(await open(), CrawlForm)[0].props.first).toBe(true);
  });

  it("asks first once there are results to look at", async () => {
    const done = { id: 2, status: "done", error: null, trigger: "manual", createdAt: new Date("2026-11-07T10:00:00Z"), finishedAt: new Date("2026-11-07T10:20:00Z"), pagesCrawled: 40, maxPages: 100, enableJavascript: false, healthScore: 81, errors: 3, warnings: 0, notices: 0, costUsd: 0 };
    finished.current = done;
    history.current = [crawl("50000 Internal Error."), done];
    expect(find<{ first: boolean }>(await open(), CrawlForm)[0].props.first).toBe(false);
  });
});

describe("/audit's results", () => {
  const done = { id: 2, status: "done", error: null, trigger: "manual", createdAt: new Date("2026-11-07T10:00:00Z"), finishedAt: new Date("2026-11-07T10:20:00Z"), pagesCrawled: 40, maxPages: 100, enableJavascript: false, healthScore: 81, errors: 3, warnings: 0, notices: 0, costUsd: 0 };

  it("lead on to Fixes when the crawl put something on the list", async () => {
    finished.current = done;
    history.current = [done];
    openFixes.current = 3;
    const next = find<{ href?: string }>(await open(), FixesNext);
    expect(next).toHaveLength(1);
  });

  it("don't when nothing is on the list to fix", async () => {
    finished.current = done;
    history.current = [done];
    expect(find(await open(), FixesNext)).toEqual([]);
  });
  it("fold notices on nearly every page under their own heading, out of Top issues", async () => {
    finished.current = done;
    history.current = [done];
    const lowText = { code: "low-text-ratio", title: "Low text-to-HTML ratio", category: "content", severity: "notice", count: 40, added: 0, fixed: 0 };
    const fewPages = { code: "render-blocking", title: "Render-blocking resources", category: "performance", severity: "notice", count: 5, added: 0, fixed: 0 };
    summaryRows.current = [MISSING_TITLE, lowText, fewPages];
    const [folded] = find<{ count: number; children: ReactElement<{ rows: { code: string }[] }> }>(await open(), SiteWideNotices);
    expect(folded.props.count).toBe(1);
    expect(folded.props.children.props.rows.map((r) => r.code)).toEqual(["low-text-ratio"]);
  });

  it("show no such heading when nothing is on nearly every page", async () => {
    finished.current = done;
    history.current = [done];
    expect(find(await open(), SiteWideNotices)).toEqual([]);
  });
});
