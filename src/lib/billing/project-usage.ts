import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { apiLedger, projects } from "@/db/schema";
import { MONTH } from "./usage";

export interface ProjectSpend {
  projectId: number;
  name: string;
  archived: boolean;
  chargedUsd: number;
}

export interface SpendByProject {
  /** Every live project, spent or not, and each archived one that spent this month. */
  projects: ProjectSpend[];
  /** Charged with no project: none was set, or it has been deleted. */
  noProjectUsd: number;
}

/**
 * This month's charges to the workspace, by project, from the ledger the meter is seeded from. The
 * join also checks the project's workspace: `api_ledger.project_id` only references `projects.id`, so
 * a row naming another workspace's project counts as no project and that project's name stays out.
 * Dollars: for working out shares on the server, never for showing a customer.
 */
export async function spendByProject(workspaceId: number): Promise<SpendByProject> {
  const [ledger, live] = await Promise.all([
    db
      .select({
        projectId: projects.id,
        name: projects.name,
        archived: projects.archived,
        chargedUsd: sql<number>`sum(${apiLedger.chargedUsd})::float`,
      })
      .from(apiLedger)
      .leftJoin(projects, and(eq(projects.id, apiLedger.projectId), eq(projects.workspaceId, apiLedger.workspaceId)))
      .where(and(eq(apiLedger.workspaceId, workspaceId), gte(apiLedger.createdAt, MONTH)))
      .groupBy(projects.id),
    db
      .select({ projectId: projects.id, name: projects.name, archived: projects.archived })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.archived, false))),
  ]);

  const byId = new Map<number, ProjectSpend>(live.map((p) => [p.projectId, { ...p, chargedUsd: 0 }]));
  let noProjectUsd = 0;
  for (const row of ledger) {
    const chargedUsd = Number(row.chargedUsd);
    if (row.projectId === null) noProjectUsd = chargedUsd;
    else byId.set(row.projectId, { projectId: row.projectId, name: row.name ?? "", archived: row.archived ?? false, chargedUsd });
  }
  return { projects: [...byId.values()], noProjectUsd };
}
