import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceMembers, workspaces, workspaceUsage } from "@/db/schema";
import { ceilingCaption, workspaceSentence } from "./brief";
import { rules } from "@/plan-policy/rules";

/**
 * The workspace page against the real spendState and spendBlock, on a stand-in database: what the
 * page says about paid calls has to match what a paid call would get.
 */
const fake = vi.hoisted(() => ({
  rows: (() => []) as (table: unknown) => unknown[],
  usage: { spentUsd: 0, reservedUsd: 0, researchUsd: 0, researchReservedUsd: 0 },
}));

vi.mock("@/db", () => ({
  db: {
    select: () => {
      let rows: unknown[] = [];
      const query = {
        from(table: unknown) {
          rows = fake.rows(table);
          return query;
        },
        leftJoin: () => query,
        innerJoin: () => query,
        where: () => query,
        then: (done: (rows: unknown[]) => unknown) => done(rows),
      };
      return query;
    },
  },
}));

vi.mock("@/lib/billing/usage", () => ({
  monthUsage: async () => fake.usage,
  platformMonthUsage: async () => fake.usage,
  reserve: async () => {
    throw new Error("the page doesn't reserve");
  },
}));

const { spendBlock, spendState } = await import("@/lib/billing/spend");

interface Setup {
  plan: string;
  spentUsd: number;
  ownCap?: number;
  limits?: Record<string, number>;
  /** What earlier months of the workspace spent. */
  priorUsd?: number;
}

const WORKSPACE_ID = 7;

/** The sentence and caption the page shows for this workspace, and what a paid call would get. */
async function pageFor({ plan, spentUsd, ownCap, limits, priorUsd = 0 }: Setup) {
  fake.usage = { spentUsd, reservedUsd: 0, researchUsd: 0, researchReservedUsd: 0 };
  fake.rows = (table) => {
    if (table === workspaces) {
      return [{ id: WORKSPACE_ID, plan, status: "active", limits: limits ?? null, trialBlockedReason: null, stripeCustomerId: "cus_test", ownCap: ownCap === undefined ? null : String(ownCap) }];
    }
    if (table === workspaceMembers) return [{ verified: true }];
    if (table === workspaceUsage) return [{ spent: String(priorUsd), research: "0" }];
    return [];
  };
  const { ceilingUsd } = await spendState(WORKSPACE_ID);
  const problems = { failed: 0, syncs: 0, connections: 0, paused: 0, billing: 0 };
  return {
    sentence: workspaceSentence({ plan: plan as "trial" | "pro" | "internal", suspended: false, spentUsd, ceilingUsd, problems }),
    caption: ceilingCaption(ceilingUsd),
    refusal: (await spendBlock(WORKSPACE_ID))?.code ?? null,
  };
}

beforeEach(() => vi.stubEnv("DATAFORSEO_MONTHLY_CAP_USD", "50"));
afterEach(() => vi.unstubAllEnvs());

describe("a trial that started last month", () => {
  it.skipIf(!rules.hasPlans)("reads as stopped once this month's spend reaches what's left of the trial", async () => {
    const page = await pageFor({ plan: "trial", priorUsd: 2.5, spentUsd: 0.5 });
    expect(page.refusal).toBe("ceiling");
    expect(page.sentence).toContain("has reached its $0.50 ceiling, so its paid calls have stopped.");
    expect(page.caption).toBe("of $0.50 ceiling");
  });

  it.skipIf(!rules.hasPlans)("measures this month's spend against what's left, not the whole $3.00", async () => {
    const page = await pageFor({ plan: "trial", priorUsd: 2.5, spentUsd: 0.1 });
    expect(page.refusal).toBeNull();
    expect(page.sentence).toContain("has spent $0.10 of its $0.50 ceiling this month.");
  });

  it.skipIf(!rules.hasPlans)("reads as stopped with nothing spent this month when earlier months used it all", async () => {
    const page = await pageFor({ plan: "trial", priorUsd: 3.2, spentUsd: 0 });
    expect(page.refusal).toBe("ceiling");
    expect(page.sentence).toContain("has reached its $0.00 ceiling, so its paid calls have stopped.");
    expect(page.caption).toBe("of $0.00 ceiling");
  });
});

describe("a workspace with its own lower cap", () => {
  it.skipIf(!rules.hasPlans)("reads as stopped at its own cap, under the plan's ceiling", async () => {
    const page = await pageFor({ plan: "pro", ownCap: 10, spentUsd: 10 });
    expect(page.refusal).toBe("ceiling");
    expect(page.sentence).toContain("has reached its $10.00 ceiling, so its paid calls have stopped.");
    expect(page.caption).toBe("of $10.00 ceiling");
  });

  it.skipIf(!rules.hasPlans)("measures spend against its own cap until then", async () => {
    const page = await pageFor({ plan: "pro", ownCap: 10, spentUsd: 4.2 });
    expect(page.refusal).toBeNull();
    expect(page.sentence).toContain("has spent $4.20 of its $10.00 ceiling this month.");
  });
});

describe("the internal workspace", () => {
  it.skipIf(!rules.hasPlans)("reads as capped at DATAFORSEO_MONTHLY_CAP_USD when it set none", async () => {
    const page = await pageFor({ plan: "internal", spentUsd: 4.2 });
    expect(page.refusal).toBeNull();
    expect(page.sentence).toContain("on the Internal plan and has spent $4.20 of its $50.00 ceiling this month.");
    expect(page.caption).toBe("of $50.00 ceiling");
  });

  it("reads as stopped at its own cap", async () => {
    const page = await pageFor({ plan: "internal", ownCap: 20, spentUsd: 20 });
    expect(page.refusal).toBe("ceiling");
    expect(page.sentence).toContain("has reached its $20.00 ceiling, so its paid calls have stopped.");
  });

  it.skipIf(!rules.hasPlans)("takes the lower of that cap and a ceiling set by hand on its limits", async () => {
    const page = await pageFor({ plan: "internal", limits: { ceilingUsd: 30 }, spentUsd: 4.2 });
    expect(page.caption).toBe("of $30.00 ceiling");
  });
});
