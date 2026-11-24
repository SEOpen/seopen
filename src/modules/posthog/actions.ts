"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { requireProject } from "@/lib/projects";
import { type ProjectScope } from "@/lib/workspace";
import { workspaceScope } from "@/lib/workspace/current";
import { resetGoogleData } from "@/modules/google/sync";
import { resetPlausibleData } from "@/modules/plausible/sync";
import { resetUmamiData } from "@/modules/umami/sync";
import { disconnectPosthogAccount } from "./account";
import { forgetPosthogProjects, listPosthogProjects } from "./projects";
import { queuePosthogSync } from "./queue";
import { resetPosthogData } from "./sync";

const projectRow = (s: ProjectScope) => and(eq(projects.workspaceId, s.workspaceId), eq(projects.id, s.projectId));

/**
 * Makes PostHog the project's Analytics source, or clears it. A project uses one source at a time,
 * because they share one table: choosing PostHog clears the GA4 property, Plausible site or Umami website and its rows.
 */
export async function setPosthogProject(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { project: p, scope } = await requireProject(projectId);
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  const raw = z.string().trim().parse(formData.get("posthogProject") ?? "");
  const posthogProject = raw || null;
  if (posthogProject === p.posthogProject) return;
  if (posthogProject) {
    // Only a project this workspace's own connection can read.
    const own = await listPosthogProjects(scope.workspaceId).catch(() => []);
    if (!own.some((x) => String(x.id) === posthogProject)) return { error: "That PostHog project isn't on this workspace's PostHog connection. Pick another, or reconnect PostHog." };
  }
  await db.update(projects).set({ posthogProject, ...(posthogProject ? { ga4Property: null, plausibleSite: null, umamiSite: null } : {}) }).where(projectRow(scope));
  if (posthogProject && p.ga4Property) await resetGoogleData(scope, "ga4");
  if (posthogProject && p.plausibleSite) await resetPlausibleData(scope);
  if (posthogProject && p.umamiSite) await resetUmamiData(scope);
  await resetPosthogData(scope);
  if (posthogProject) await queuePosthogSync(scope, posthogProject);
  refresh();
}

export async function disconnectPosthog() {
  await requireSession();
  const { workspaceId } = await workspaceScope();
  const res = await disconnectPosthogAccount(workspaceId);
  if (!res.ok) redirect("/ga4?posthog_error=disconnect_failed");
  forgetPosthogProjects(workspaceId);
  refresh();
}
