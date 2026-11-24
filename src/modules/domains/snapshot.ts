import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { domainsSnapshots } from "@/db/schema";
import type { Project } from "@/lib/projects";
import type { ProjectScope } from "@/lib/workspace";
import type { Market } from "@/modules/keywords/requests";
import { distribution, kpis, type HistoryPoint } from "./transform";
import type { OrganicMetrics } from "./types";

export type Snapshot = typeof domainsSnapshots.$inferSelect;

/** Upserts today's snapshot for the project's own domain. History is kept from an earlier row when not given. */
export async function recordSnapshot(project: Project, m: Market, organic: OrganicMetrics, history: HistoryPoint[] | null) {
  const k = kpis(organic)!;
  const date = new Date().toISOString().slice(0, 10);
  const values = {
    workspaceId: project.workspaceId,
    projectId: project.id,
    domain: project.domain,
    locationCode: m.locationCode,
    languageCode: m.languageCode,
    date,
    ...k,
    distribution: distribution(organic),
    changes: { new: organic.is_new, up: organic.is_up, down: organic.is_down, lost: organic.is_lost },
    history: history?.map(({ date, traffic, keywords, top10 }) => ({ date, traffic, keywords, top10 })) ?? null,
  };
  const { history: h, ...rest } = values;
  await db
    .insert(domainsSnapshots)
    .values(values)
    .onConflictDoUpdate({ target: [domainsSnapshots.projectId, domainsSnapshots.date], set: h ? values : rest });
}

/** Most recent snapshots for a project, newest first. */
export async function latestSnapshots(scope: ProjectScope, limit = 2): Promise<Snapshot[]> {
  return db
    .select()
    .from(domainsSnapshots)
    .where(and(eq(domainsSnapshots.workspaceId, scope.workspaceId), eq(domainsSnapshots.projectId, scope.projectId)))
    .orderBy(desc(domainsSnapshots.date))
    .limit(limit);
}
