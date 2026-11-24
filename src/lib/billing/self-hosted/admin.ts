import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { formatNumber } from "@/lib/format";
import type { PlanAdmin } from "../policy";

/**
 * A copy without plans (`@/plan-policy/admin`, policy.ts): Admin shows what this copy holds and spends,
 * and nothing about money coming in. A workspace stops only when an admin suspends it.
 */
export const admin: PlanAdmin = {
  async overview() {
    const [row] = await db.execute<{ workspaces: number; projects: number }>(sql`
      select (select count(*)::int from workspaces) as workspaces, (select count(*)::int from projects where not archived) as projects`);
    return {
      description: "This copy at a glance, read live from the database.",
      figures: [
        { state: "value", id: "workspaces", label: "Workspaces", value: formatNumber(row.workspaces), delta: null },
        { state: "value", id: "projects", label: "Active projects", value: formatNumber(row.projects), delta: null },
      ],
      daily: [],
      funnel: null,
    };
  },

  async stopped() {
    const rows = await db.select({ workspaceId: workspaces.id, workspace: workspaces.name, plan: workspaces.plan }).from(workspaces).where(eq(workspaces.status, "suspended"));
    return {
      label: "Suspended workspaces",
      title: "Suspended",
      description: "Workspaces an admin suspended: their paid calls and jobs are stopped. Restore one from its page.",
      filename: "suspended-workspaces",
      noun: "suspended workspace",
      figure: "Spend and suspended",
      rows: rows.map((r) => ({ ...r, problem: "Suspended" })),
    };
  },

  workspaces: async () => ({ figures: [], kinds: [], byId: new Map() }),

  workspace: async () => ({ title: "Plan", status: null, facts: [], problems: 0, problemsCaption: "jobs, syncs and connections" }),
};
