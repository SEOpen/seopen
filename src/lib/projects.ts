import { and, asc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { competitors, projects } from "@/db/schema";
import { projectScope, type ProjectScope } from "@/lib/workspace";
import { currentWorkspace } from "@/lib/workspace/current";
import { PROJECT_COOKIE } from "./project-cookie";

export { PROJECT_COOKIE };

export type Project = typeof projects.$inferSelect;

/** The current workspace's projects. Cached per request: the shell's project switcher and the page both read it on every load. */
export const listProjects = cache(async (): Promise<Project[]> => {
  const ws = await currentWorkspace();
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, ws.id), eq(projects.archived, false)))
    .orderBy(asc(projects.name));
});

/** The current workspace's archived projects, listed at the bottom of the projects list. */
export async function listArchivedProjects(): Promise<Project[]> {
  const ws = await currentWorkspace();
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, ws.id), eq(projects.archived, true)))
    .orderBy(asc(projects.name));
}

/** A project of the current workspace (archived ones too), or null. */
export async function getProject(id: number): Promise<Project | null> {
  // An id past the column's range is no project; asking Postgres for it is an error, not an empty result.
  if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) return null;
  const ws = await currentWorkspace();
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.workspaceId, ws.id)));
  return row ?? null;
}

/**
 * For Server Actions and API routes that receive a project id from the client: the project and
 * its scope when the current workspace owns it, otherwise a 404. Never trust an id from a form
 * without this.
 */
export async function requireProject(id: number): Promise<{ project: Project; scope: ProjectScope }> {
  const project = await getProject(Number(id));
  if (!project) notFound();
  return { project, scope: projectScope(project) };
}

/** The project picked in the switcher, or the first project. Null when there are none. A cookie naming another workspace's project is ignored. */
export const getCurrentProject = cache(async (): Promise<Project | null> => {
  const id = Number((await cookies()).get(PROJECT_COOKIE)?.value);
  const all = await listProjects();
  return all.find((p) => p.id === id) ?? all[0] ?? null;
});

export async function listCompetitors(scope: ProjectScope): Promise<string[]> {
  const rows = await db
    .select({ domain: competitors.domain })
    .from(competitors)
    .where(and(eq(competitors.workspaceId, scope.workspaceId), eq(competitors.projectId, scope.projectId)))
    .orderBy(asc(competitors.domain));
  return rows.map((r) => r.domain);
}

/** "https://www.Example.com/path" → "example.com". Keeps subdomains other than www. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  return s.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
}
