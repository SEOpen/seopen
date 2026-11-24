import "server-only";
import { cache } from "react";
import { isAdmin } from "@/lib/admin/access";
import { requireSession } from "@/lib/auth/session";
import { lockedProjectIds } from "@/lib/billing/gates";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { getCurrentProject, listArchivedProjects, listProjects } from "@/lib/projects";
import { workspaceScope } from "@/lib/workspace/current";

export interface ShellProject {
  id: number;
  name: string;
  domain: string;
  /** Over the plan's project limit: its data stays, but nothing new runs for it. */
  locked: boolean;
}

/** What the sidebar needs, sent as one promise so the layout's shell stays static. */
export interface ShellData {
  projects: ShellProject[];
  currentId: number | null;
  archived: number;
  owner: boolean;
  email: string;
}

export const loadShell = cache(async (): Promise<ShellData> => {
  const user = await requireSession();
  const [projects, current, archived, owner, scope] = await Promise.all([listProjects(), getCurrentProject(), listArchivedProjects(), isAdmin(user.id), workspaceScope()]);
  const locked = lockedProjectIds(await loadBillingWorkspace(scope.workspaceId), projects);
  return {
    projects: projects.map((p) => ({ id: p.id, name: p.name, domain: p.domain, locked: locked.has(p.id) })),
    currentId: current?.id ?? null,
    archived: archived.length,
    owner,
    email: user.email,
  };
});
