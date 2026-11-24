"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { track } from "@/lib/analytics/server";
import { requireSession } from "@/lib/auth/session";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { loadBillingWorkspace, projectActionRefusal } from "@/lib/billing/workspace";
import { requireProject } from "@/lib/projects";
import { type ProjectScope } from "@/lib/workspace";
import { currentWorkspace, workspaceScope } from "@/lib/workspace/current";
import { resetGoogleData } from "@/modules/google/sync";
import { resetPosthogData } from "@/modules/posthog/sync";
import { resetUmamiData } from "@/modules/umami/sync";
import { disconnectPlausibleAccount, savePlausibleAccount } from "./account";
import { checkPlausibleKey } from "./api";
import { PLAUSIBLE_CLOSED, plausibleOpen } from "./gate";
import { queuePlausibleSync } from "./queue";
import { forgetPlausibleSites, listPlausibleSites } from "./sites";
import { resetPlausibleData } from "./sync";
import { PlausibleAccessError, PlausibleNotConnectedError, PlausibleQuotaError, type PlausibleSite } from "./types";

const projectRow = (s: ProjectScope) => and(eq(projects.workspaceId, s.workspaceId), eq(projects.id, s.projectId));

/** Longer than any key Plausible issues, and short enough that this can't be used to store a blob. */
const pastedKey = z.string().trim().min(1).max(512);

/**
 * Checks a pasted Stats API key with Plausible and stores it, encrypted, as this workspace's
 * connection. The key is never sent back to the browser, and nothing it says on failure repeats it.
 */
export async function connectPlausible(formData: FormData): Promise<ActionResult> {
  const user = await requireSession();
  const workspace = await currentWorkspace();
  if (!plausibleOpen(workspace)) return { error: PLAUSIBLE_CLOSED };
  const workspaceId = workspace.id;
  const parsed = pastedKey.safeParse(formData.get("plausibleKey"));
  if (!parsed.success) return { error: "Paste your Plausible Stats API key." };
  const check = await checkPlausibleKey(parsed.data);
  if (!check.ok) return { error: check.error };
  await savePlausibleAccount(workspaceId, parsed.data);
  forgetPlausibleSites(workspaceId);
  track(user.id, "module_activated", { module: "plausible" }, { workspaceId });
  refresh();
}

/**
 * Makes Plausible the project's Analytics source, or clears it. A project uses one source at a time,
 * because they share one table: choosing Plausible clears the GA4 property, PostHog project or Umami website and its rows.
 * The gate only stops setting a site, so a project mapped before it closed can always stop using Plausible.
 */
export async function setPlausibleSite(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { project: p, scope } = await requireProject(projectId);
  const raw = z.string().trim().parse(formData.get("plausibleSite") ?? "");
  const plausibleSite = raw || null;
  if (plausibleSite && !plausibleOpen(await loadBillingWorkspace(scope.workspaceId))) return { error: PLAUSIBLE_CLOSED };
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  if (plausibleSite === p.plausibleSite) return;
  if (plausibleSite) {
    // Only a site this workspace's own key can read. A rate limit says so. No connection, or a key
    // that can't read sites, means the site isn't on it. Anything else is a real failure.
    let own: PlausibleSite[];
    try {
      own = await listPlausibleSites(scope.workspaceId);
    } catch (err) {
      if (err instanceof PlausibleQuotaError) return { error: "Plausible is limiting requests for this key, so its sites can't be checked. Try again in a few minutes." };
      if (!(err instanceof PlausibleNotConnectedError || err instanceof PlausibleAccessError)) throw err;
      own = [];
    }
    if (!own.some((s) => s.domain === plausibleSite)) return { error: "That site isn't on this workspace's Plausible connection. Pick another, or reconnect Plausible." };
  }
  await db.update(projects).set({ plausibleSite, ...(plausibleSite ? { ga4Property: null, posthogProject: null, umamiSite: null } : {}) }).where(projectRow(scope));
  if (plausibleSite && p.ga4Property) await resetGoogleData(scope, "ga4");
  if (plausibleSite && p.posthogProject) await resetPosthogData(scope);
  if (plausibleSite && p.umamiSite) await resetUmamiData(scope);
  await resetPlausibleData(scope);
  if (plausibleSite) await queuePlausibleSync(scope, plausibleSite);
  refresh();
}

/** Deletes the workspace's key. Mapped projects keep what's stored, and their syncs say to reconnect. */
export async function disconnectPlausible() {
  await requireSession();
  const { workspaceId } = await workspaceScope();
  await disconnectPlausibleAccount(workspaceId);
  forgetPlausibleSites(workspaceId);
  refresh();
}
