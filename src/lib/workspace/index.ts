import { and, eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { projects, workspaceSettings, workspaces } from "@/db/schema";
import type { Refusal } from "@/lib/billing/errors";
import { checkPaidJob } from "@/lib/billing/jobs-gate";
import { resolveTimeZone } from "@/lib/format";

/**
 * Tenancy, the scoped data-access layer. Every tenant row has a `workspace_id`, and every query
 * on a tenant table filters on it:
 *
 * - Requests (pages, Server Actions, API routes) resolve the workspace with `currentWorkspace()`
 *   and the project with `getCurrentProject()` / `requireProject(id)` from `@/lib/projects`, both
 *   of which only return the current workspace's projects. Module functions then take a
 *   `ProjectScope` (or a `WorkspaceScope`) and filter on both ids.
 * - Jobs carry `{ workspaceId, projectId }` in their payload and call `jobScope()` first, which
 *   checks the pair in the database and refuses a mismatched, archived or suspended one.
 * - Child ids from a URL or form (a crawl, list, run, prompt or keyword id) are always looked up
 *   together with the scope, never alone.
 */

/** The owner's workspace, created by the tenancy migration with every row from before tenancy. */
export const OWNER_WORKSPACE_ID = 1;

// The request side (`currentWorkspace()`, `workspaceScope()`) lives in ./current, which is
// server-only; this file is also loaded by the worker, so it must not import it.

export interface WorkspaceScope {
  workspaceId: number;
}

/** A workspace and one of its projects. Queries filter on both. */
export interface ProjectScope extends WorkspaceScope {
  projectId: number;
}

/** The zone this workspace reads its dates and times in. A missing settings row means the default. */
export async function workspaceTimeZone(scope: WorkspaceScope): Promise<string> {
  const [row] = await db.select({ timeZone: workspaceSettings.timeZone }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, scope.workspaceId));
  return resolveTimeZone(row?.timeZone);
}

/** `table.workspace_id = scope.workspaceId and table.project_id = scope.projectId`. */
export function inScope(table: { workspaceId: AnyPgColumn; projectId: AnyPgColumn }, scope: ProjectScope): SQL {
  return and(eq(table.workspaceId, scope.workspaceId), eq(table.projectId, scope.projectId))!;
}

/** The scope of a project row. It uses the row's own workspace id, so it can't be mismatched. */
export function projectScope(project: { id: number; workspaceId: number }): ProjectScope {
  return { workspaceId: project.workspaceId, projectId: project.id };
}

/** Job payload for a project job. Every project job's payload extends this. */
export interface ProjectJobPayload {
  workspaceId?: number;
  projectId?: number;
}

export type JobScope =
  | { ok: true; scope: ProjectScope; project: typeof projects.$inferSelect }
  | { ok: false; reason: string; refusal?: Refusal };

/**
 * The first thing a project job's handler does: reload the project and check it still belongs to
 * the payload's workspace, isn't archived, and that the workspace is active. A mismatch (a payload
 * naming another workspace's project, or one queued before tenancy without a workspace) stops the
 * job quietly with the reason, instead of acting on someone else's data.
 *
 * `paid: true` is for jobs that spend: a workspace that can't spend (no plan, a limit reached,
 * suspended) or a project that's read-only after a downgrade pauses the job with a banner
 * (src/lib/billing/jobs-gate.ts) instead of failing it. A job refused here with a run or check row
 * waiting on it closes that row, since nothing else will.
 */
export async function jobScope(payload: ProjectJobPayload, opts: { allowArchived?: boolean; paid?: boolean } = {}): Promise<JobScope> {
  const { workspaceId, projectId } = payload;
  if (!Number.isInteger(workspaceId) || !Number.isInteger(projectId)) return { ok: false, reason: "payload has no workspaceId/projectId" };
  const [row] = await db
    .select({ project: projects, status: workspaces.status })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(and(eq(projects.id, projectId!), eq(projects.workspaceId, workspaceId!)));
  if (!row) return { ok: false, reason: `project ${projectId} is not in workspace ${workspaceId}` };
  if (row.status !== "active") return { ok: false, reason: `workspace ${workspaceId} is ${row.status}` };
  if (row.project.archived && !opts.allowArchived) return { ok: false, reason: `project ${projectId} is archived` };
  const scope = projectScope(row.project);
  if (opts.paid) {
    const refusal = await checkPaidJob(payload, scope);
    if (refusal) return { ok: false, reason: `paused (${refusal.code}): ${refusal.message}`, refusal };
  }
  return { ok: true, scope, project: row.project };
}

/**
 * Active projects in active workspaces, for scheduled jobs that fan out one job per project.
 * `where` narrows the projects further (e.g. only those mapped to a Search Console property).
 */
export async function activeProjects(where?: Parameters<typeof and>[number]): Promise<ProjectScope[]> {
  const rows = await db
    .select({ id: projects.id, workspaceId: projects.workspaceId })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(and(eq(projects.archived, false), eq(workspaces.status, "active"), where));
  return rows.map(projectScope);
}
