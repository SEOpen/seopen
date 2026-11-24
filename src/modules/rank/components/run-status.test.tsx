import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { creditsRefusal, FREE_PLAN_REFUSAL } from "@/lib/billing/spend";
import type { Refusal } from "@/lib/billing/errors";
import type { TrackerState } from "../queries";
import { rules } from "@/plan-policy/rules";

const zone = vi.hoisted(() => ({ current: "UTC" }));
const refusal = vi.hoisted(() => ({ current: null as Refusal | null }));
const stateRefusal = vi.hoisted(() => ({ current: null as Refusal | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/rank", useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/workspace/current", () => ({ currentTimeZone: async () => zone.current, currentWorkspace: async () => ({ id: 7, plan: "starter" }) }));
vi.mock("@/lib/billing/check-gate", () => ({ checkGate: async () => () => refusal.current }));
vi.mock("@/lib/billing/spend", async (original) => ({ ...(await original<typeof import("@/lib/billing/spend")>()), spendState: async () => ({ refusal: stateRefusal.current }) }));

const { CheckNowButtons, RunStatus } = await import("./chrome");

const LATE = new Date("2026-11-07T02:00:00Z");
const failedRun = { status: "failed", error: null, createdAt: LATE, finishedAt: LATE };
const state = (over: Partial<TrackerState> = {}) =>
  ({
    settings: { workspaceId: 7, projectId: 1, dailyDepth: 10, sweepDepth: 100 },
    place: { current: true, name: "Salem" },
    places: [],
    keywords: [{ active: true }],
    dates: ["2026-11-05"],
    activeRun: null,
    lastRun: { status: "done", createdAt: new Date("2026-11-05T12:00:00Z"), finishedAt: new Date("2026-11-05T12:00:00Z") },
    newestRun: failedRun,
    ...over,
  }) as unknown as TrackerState;

const text = async (s: TrackerState, resultsBelow?: boolean) =>
  renderToStaticMarkup((await RunStatus({ state: s, resultsBelow })) as ReactElement).replace(/&#x27;/g, "'");

beforeEach(() => {
  zone.current = "UTC";
  refusal.current = null;
  stateRefusal.current = null;
});

describe("the failed check's callout", () => {
  it("offers the button when it would work", async () => {
    const html = await text(state());
    expect(html).toContain("Last check failed");
    expect(html).toContain("Results below are from Nov 5.");
    expect(html).toContain("Check now runs it again.");
  });

  it("uses the day the sentence does, in a zone behind UTC", async () => {
    zone.current = "America/Los_Angeles";
    const late = new Date("2026-11-07T02:00:00Z");
    expect(await text(state({ lastRun: { ...state().lastRun!, finishedAt: late, createdAt: late }, dates: ["2026-11-07"] }))).toContain("Results below are from Nov 7.");
  });

  it("names no results after a move, when this place has none", async () => {
    const html = await text(state({ dates: [] }));
    expect(html).not.toContain("Results below");
    expect(html).not.toContain("Oct 31");
  });

  it("doesn't say Results below over a table of runs", async () => {
    const html = await text(state(), false);
    expect(html).not.toContain("Results below");
    expect(html).toContain("The latest results are from Nov 5.");
  });

  it.skipIf(!rules.hasPlans)("gives the refusal and Billing instead of the offer when the workspace can't spend", async () => {
    refusal.current = creditsRefusal({ plan: "starter" }, 10);
    const html = await text(state());
    expect(html).not.toContain("runs it again");
    expect(html).toContain(refusal.current.message);
    expect(html).toContain('href="/billing"');
  });

  it("says a stale posting row didn't start, quietly, with the offer when it would work", async () => {
    const posting = { status: "posting", error: null, createdAt: new Date(Date.now() - 2 * 3_600_000) } as unknown as TrackerState["newestRun"];
    const html = await text(state({ newestRun: posting }));
    expect(html).toContain("Last check didn't start");
    expect(html).toContain("This check didn't start.");
    expect(html).toContain("Check now runs it again.");
    expect(html).not.toContain("failed");
  });

  it("says why a stale posting row can't run again on Free", async () => {
    refusal.current = FREE_PLAN_REFUSAL;
    const posting = { status: "posting", error: null, createdAt: new Date(Date.now() - 2 * 3_600_000) } as unknown as TrackerState["newestRun"];
    const html = await text(state({ newestRun: posting }));
    expect(html).toContain("Last check didn't start");
    expect(html).not.toContain("runs it again");
    expect(html).toContain(FREE_PLAN_REFUSAL.message.replace(/'/g, "'"));
  });
});

describe("the button", () => {
  const hasResults = async (s: TrackerState) => {
    const el = (await CheckNowButtons({ project: { id: 1, workspaceId: 7 } as never, state: s })) as ReactElement<{ hasResults: boolean }>;
    return el.props.hasResults;
  };

  it("isn't the page's main action when it would refuse", async () => {
    expect(await hasResults(state({ dates: [] }))).toBe(false);
    refusal.current = FREE_PLAN_REFUSAL;
    expect(await hasResults(state({ dates: [] }))).toBe(true);
  });
});

describe("Check now while the workspace can't spend", () => {
  const refused = async () => {
    const el = (await CheckNowButtons({ project: { id: 1, workspaceId: 7 } as never, state: state() })) as ReactElement<{ refused?: string }>;
    return el.props.refused;
  };

  it("hands the form the banner's reason, so its buttons are off", async () => {
    stateRefusal.current = { code: "suspended", message: "This workspace is suspended.", upgradable: false };
    expect(await refused()).toBe("This workspace is suspended.");
  });

  it("turns them off with the plan's reason on Free, where the banner says nothing", async () => {
    refusal.current = FREE_PLAN_REFUSAL;
    expect(await refused()).toBe(FREE_PLAN_REFUSAL.message);
  });

  it("leaves them on otherwise", async () => {
    expect(await refused()).toBeUndefined();
  });
});
