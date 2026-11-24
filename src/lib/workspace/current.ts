import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { projects, workspaceMembers, workspaceSettings, workspaces } from "@/db/schema";
import { getCurrentUser, requireSession } from "@/lib/auth/session";
import { withEndedGrant } from "@/lib/billing/gates";
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "@/lib/format";
import { takesBrowserZone } from "./browser-time-zone";
import type { WorkspaceScope } from "./index";

export type Workspace = typeof workspaces.$inferSelect;

/** The user's owner memberships: the only role anything here honors (see `currentWorkspace`). */
const ownMembership = (userId: string) => and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.role, "owner"));

/**
 * The workspace this request acts for. Every page, Server Action and API route resolves the
 * workspace here and nowhere else; module code gets it through `requireProject()` /
 * `projectScope()` and the scope types in `@/lib/workspace`.
 *
 * - A signed-in account gets the workspace it is a member of (the oldest membership, until
 *   accounts can belong to several and pick one). An account without a membership is refused; it
 *   never falls back to the owner's workspace. An admin's is sent to /admin instead: deleting its
 *   last workspace keeps the account (`deleteWorkspaceOp`), and Admin needs no workspace.
 * - Only an `owner` membership counts (`ownMembership`). Nothing checks a member's role yet: API
 *   keys, connected apps, project deletion and spending are open to anyone the workspace resolves
 *   for. So a membership with any other role reads as none until roles are enforced, and adding one
 *   fails closed.
 * - Signed out: `requireSession()` redirects to /sign-in.
 *
 * Cached per request with React `cache()`, like `getCurrentProject()`. A grant past its end date
 * reads as ended (`withEndedGrant`), as it does to the spend gate.
 */
export const currentWorkspace = cache(async (): Promise<Workspace> => {
  const user = await requireSession();
  const [row] = await db
    .select({ ws: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(ownMembership(user.id))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    .limit(1);
  if (!row) {
    // Loaded only here, so every page that resolves a workspace doesn't import Admin's access code.
    const { isAdmin } = await import("@/lib/admin/access");
    if (await isAdmin(user.id)) redirect("/admin");
    throw new Error("This account isn't a member of any workspace yet.");
  }
  return withEndedGrant(row.ws);
});

/** The current request's workspace as a scope. */
export async function workspaceScope(): Promise<WorkspaceScope> {
  return { workspaceId: (await currentWorkspace()).id };
}

/** Postgres refuses a bigger number for an integer column, and a URL can hold any number. */
const MAX_PROJECT_ID = 2_147_483_647;

/**
 * Whether a project is one `listProjects()` would give this account: unarchived, in the workspace
 * `currentWorkspace()` picks. For proxy.ts, which has the session's user but no request cache, so it
 * takes the user instead of asking `requireSession()`.
 */
export async function isLiveProject(userId: string, projectId: number): Promise<boolean> {
  if (!Number.isInteger(projectId) || projectId < 1 || projectId > MAX_PROJECT_ID) return false;
  const workspace = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    .limit(1);
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.archived, false), eq(projects.workspaceId, workspace)));
  return row != null;
}

/**
 * The zone this request's dates and times read in: `workspaceSettings.timeZone` of the workspace
 * `currentWorkspace()` picks, once per request. Layouts read it for client components, so it never
 * redirects or throws: signed out or without a workspace it's the default, and the page's own
 * `requireSession()` / `currentWorkspace()` still does the refusing. Admin pages use it too, so an
 * event reads the same across workspaces: the admin's own workspace sets the zone there.
 */
export const currentTimeZone = cache(async (): Promise<string> => {
  const user = await getCurrentUser();
  if (!user) return DEFAULT_TIME_ZONE;
  const [row] = await db
    .select({ timeZone: workspaceSettings.timeZone })
    .from(workspaceMembers)
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaceMembers.workspaceId))
    .where(ownMembership(user.id))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    .limit(1);
  return resolveTimeZone(row?.timeZone);
});

/**
 * Whether the workspace `currentWorkspace()` picks can still take its zone from a browser, once per
 * request. The layout asks on every page, so like `currentTimeZone()` it never redirects or throws.
 */
export const timeZoneStillUnchosen = cache(async (): Promise<boolean> => {
  const user = await getCurrentUser();
  if (!user) return false;
  const [row] = await db
    .select({ createdAt: workspaces.createdAt, settings: workspaceSettings.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaceMembers.workspaceId))
    .where(ownMembership(user.id))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    .limit(1);
  return row != null && takesBrowserZone(row, row.settings);
});
