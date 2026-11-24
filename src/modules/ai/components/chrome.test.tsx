import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE_PLAN_REFUSAL } from "@/lib/billing/spend";
import type { Refusal } from "@/lib/billing/errors";
import { rules } from "@/plan-policy/rules";

const refusal = vi.hoisted(() => ({ current: null as Refusal | null }));
const runs = vi.hoisted(() => ({ current: [] as unknown[] }));
const latest = vi.hoisted(() => ({ current: null as Date | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/ai", useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/workspace/current", () => ({ currentTimeZone: async () => "UTC", currentWorkspace: async () => ({ id: 7, plan: "starter" }) }));
vi.mock("@/lib/billing/check-gate", () => ({ checkGate: async () => () => refusal.current }));
vi.mock("../data", () => ({ activeRun: async () => null, listRuns: async () => runs.current, latestAnswerAt: async () => latest.current }));

const { RunStatus } = await import("./chrome");

const scope = { workspaceId: 7, projectId: 1 };
const NOV7 = new Date("2026-11-07T10:00:00Z");
const OCT31 = new Date("2026-10-31T10:00:00Z");
const failed = (error: string) => ({ status: "failed", error, startedAt: NOV7 });
const text = async (props: Partial<Parameters<typeof RunStatus>[0]> = {}) => renderToStaticMarkup((await RunStatus({ scope, ...props })) as ReactElement).replace(/&#x27;/g, "'");

beforeEach(() => {
  refusal.current = null;
  latest.current = OCT31;
  runs.current = [failed("None of this run's answers came back")];
});

describe("the failed run's callout", () => {
  it("offers Run now where there is one", async () => {
    expect(await text()).toMatch(/Run it again/);
  });

  it("doesn't mention a Run now on a page without one", async () => {
    const html = await text({ canRun: false });
    expect(html).toContain("Last run failed");
    expect(html).not.toMatch(/Run now|run it again/i);
  });

  it("offers Run now in its own words only where it can, when the reason doesn't", async () => {
    runs.current = [failed("Run stopped before this task was posted")];
    expect(await text()).toContain("Run now runs it again.");
    expect(await text({ canRun: false })).not.toContain("Run now");
  });

  it("doesn't advise running it again through the stored reason either", async () => {
    runs.current = [failed("Timed out")];
    expect(await text({ canRun: false })).not.toMatch(/Run now|run it again/i);
  });

  it("gives one date for the answers, the one the header has", async () => {
    expect(await text({ answersAt: NOV7 })).toContain("Answers are from Nov 7.");
    expect(await text({ answersAt: NOV7 })).not.toContain("Oct 31");
    expect(await text()).toContain("Answers are from Oct 31.");
  });

  it("says nothing about answers when there aren't any", async () => {
    expect(await text({ answersAt: null })).not.toContain("Answers are from");
  });

  it.skipIf(!rules.hasPlans)("gives the refusal instead of the offer on a plan that can't run it", async () => {
    refusal.current = FREE_PLAN_REFUSAL;
    const html = await text();
    expect(html).not.toMatch(/Run now|run it again/i);
    expect(html).toContain('href="/billing"');
  });
});
