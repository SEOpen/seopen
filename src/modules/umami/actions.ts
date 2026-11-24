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
import { resetPlausibleData } from "@/modules/plausible/sync";
import { resetPosthogData } from "@/modules/posthog/sync";
import { disconnectUmamiAccount, saveUmamiAccount, type UmamiAuthType } from "./account";
import { checkUmami, loginUmami } from "./api";
import { UMAMI_CLOSED, umamiOpen } from "./gate";
import { queueUmamiSync } from "./queue";
import { normalizeUmamiServer } from "./server";
import { forgetUmamiSites, listUmamiSites } from "./sites";
import { resetUmamiData } from "./sync";
import { UmamiAccessError, UmamiNotConnectedError, UmamiQuotaError, UmamiUnreachableError, type UmamiSite } from "./types";

const projectRow = (s: ProjectScope) => and(eq(projects.workspaceId, s.workspaceId), eq(projects.id, s.projectId));

/** Longer than any key or login Umami issues, and short enough that this can't be used to store a blob. */
const field = z.string().trim().max(512);
const optional = (v: FormDataEntryValue | null) => field.safeParse(v ?? "");

/**
 * Checks a pasted Umami credential and stores it, encrypted, as this workspace's connection. Umami
 * Cloud takes an API key; a self-hosted server takes an API key or a username and password, which
 * sign in once for a token. Only the key or the token is stored, never the password. Nothing is sent
 * back to the browser, and nothing this says on failure repeats what was pasted.
 */
export async function connectUmami(formData: FormData): Promise<ActionResult> {
  const user = await requireSession();
  const workspace = await currentWorkspace();
  if (!umamiOpen(workspace)) return { error: UMAMI_CLOSED };
  const [server, key, username, password] = [optional(formData.get("umamiServer")), optional(formData.get("umamiKey")), optional(formData.get("umamiUsername")), z.string().max(512).safeParse(formData.get("umamiPassword") ?? "")];
  if (!server.success || !key.success || !username.success || !password.success) return { error: "One of those is too long to be an Umami address, key or login." };
  const address = normalizeUmamiServer(server.data);
  if (!address.ok) return { error: address.error };
  const { baseUrl } = address;

  let authType: UmamiAuthType = "api_key";
  let credential = key.data;
  if (!credential) {
    if (!baseUrl) return { error: "Paste your Umami Cloud API key." };
    if (!username.data || !password.data) return { error: "Paste an Umami API key, or enter the username and password you sign in to your Umami server with." };
    const login = await loginUmami(baseUrl, username.data, password.data);
    if (!login.ok) return { error: login.error };
    authType = "login";
    credential = login.token;
  }

  const check = await checkUmami({ baseUrl, authType, credential });
  if (!check.ok) return { error: check.error };
  await saveUmamiAccount(workspace.id, { baseUrl, authType, credential });
  forgetUmamiSites(workspace.id);
  track(user.id, "module_activated", { module: "umami" }, { workspaceId: workspace.id });
  refresh();
}

/**
 * Makes Umami the project's Analytics source, or clears it. A project uses one source at a time,
 * because they share one table: choosing Umami clears the GA4 property, PostHog project or Plausible site and its rows.
 * The gate only stops setting a website, so a project mapped before it closed can always stop using Umami.
 */
export async function setUmamiSite(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { project: p, scope } = await requireProject(projectId);
  const raw = z.string().trim().parse(formData.get("umamiSite") ?? "");
  const umamiSite = raw || null;
  if (umamiSite && !umamiOpen(await loadBillingWorkspace(scope.workspaceId))) return { error: UMAMI_CLOSED };
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  if (umamiSite === p.umamiSite) return;
  if (umamiSite) {
    // Only a website this workspace's own connection can read. A rate limit or an unreachable server says so. No
    // connection, or one that can't read websites, means the website isn't on it. Anything else is a real failure.
    let own: UmamiSite[];
    try {
      own = await listUmamiSites(scope.workspaceId);
    } catch (err) {
      if (err instanceof UmamiQuotaError) return { error: "Umami is limiting requests for this connection, so its websites can't be checked. Try again in a few minutes." };
      if (err instanceof UmamiUnreachableError) return { error: err.message };
      if (!(err instanceof UmamiNotConnectedError || err instanceof UmamiAccessError)) throw err;
      own = [];
    }
    if (!own.some((s) => s.id === umamiSite)) return { error: "That website isn't on this workspace's Umami connection. Pick another, or reconnect Umami." };
  }
  await db
    .update(projects)
    .set({ umamiSite, ...(umamiSite ? { ga4Property: null, posthogProject: null, plausibleSite: null } : {}) })
    .where(projectRow(scope));
  if (umamiSite && p.ga4Property) await resetGoogleData(scope, "ga4");
  if (umamiSite && p.posthogProject) await resetPosthogData(scope);
  if (umamiSite && p.plausibleSite) await resetPlausibleData(scope);
  await resetUmamiData(scope);
  if (umamiSite) await queueUmamiSync(scope, umamiSite);
  refresh();
}

/** Deletes the workspace's credential. Mapped projects keep what's stored, and their syncs say to reconnect. */
export async function disconnectUmami() {
  await requireSession();
  const { workspaceId } = await workspaceScope();
  await disconnectUmamiAccount(workspaceId);
  forgetUmamiSites(workspaceId);
  refresh();
}
