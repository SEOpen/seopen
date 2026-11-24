"use server";

import { and, eq, notInArray } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { saveInspection } from "@/modules/indexing/inspection";
import { track } from "@/lib/analytics/server";
import { googleSyncState, projects, rankSettings } from "@/db/schema";
import { isInternal } from "@/lib/billing/gates";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { loadBillingWorkspace, projectActionRefusal, projectGate, SAAS_DAILY_DEPTH } from "@/lib/billing/workspace";
import { enqueue } from "@/lib/jobs/boss";
import { listProjects, normalizeDomain, requireProject, type Project } from "@/lib/projects";
import { projectScope, type ProjectScope } from "@/lib/workspace";
import { workspaceScope } from "@/lib/workspace/current";
import { googleApis } from "./apis";
import { disconnectAccount } from "./auth";
import { inspectFailureMessage, urlInProperty } from "./inspect-url";
import { planImport, selectImports, usableSite } from "./matching";
import { forgetGoogleProperties, listGoogleProperties } from "./properties";
import { resetGoogleData, type Source } from "./sync";
import { queuePlausibleSync } from "@/modules/plausible/queue";
import { resetPlausibleData } from "@/modules/plausible/sync";
import { queueUmamiSync } from "@/modules/umami/queue";
import { resetUmamiData } from "@/modules/umami/sync";
import { queuePosthogSync } from "@/modules/posthog/queue";
import { resetPosthogData } from "@/modules/posthog/sync";
import { GSC_TIME_ZONE, historyStart, todayIn } from "./windowing";
import { requireSession } from "@/lib/auth/session";
import { hooks } from "@/plan-policy/hooks";

/** The project row of a scope (callers got the scope from `requireProject`). */
const projectRow = (s: ProjectScope) => and(eq(projects.workspaceId, s.workspaceId), eq(projects.id, s.projectId));

async function queueSync(p: Project, sources: Source[]) {
  const scope = projectScope(p);
  for (const source of sources) {
    const property = source === "gsc" ? p.gscProperty : p.ga4Property;
    if (!property) continue;
    const jobId = await enqueue(`google.${source}.sync`, scope, { singletonKey: `project:${p.id}` });
    // Rejected: a run is already waiting, e.g. a quota back-off. Its state row already says when.
    if (!jobId) continue;
    await db
      .insert(googleSyncState)
      .values({ ...scope, source, property, backfillStart: historyStart(todayIn(GSC_TIME_ZONE)), status: "queued", message: "Waiting for the worker" })
      .onConflictDoUpdate({
        target: [googleSyncState.projectId, googleSyncState.source],
        set: { status: "queued", message: "Waiting for the worker" },
        // A running sync or a quota pause is more useful to show than "queued".
        setWhere: notInArray(googleSyncState.status, ["running", "quota"]),
      });
  }
}

export async function syncNow(projectId: number) {
  await requireSession();
  const { project, scope } = await requireProject(projectId);
  await queueSync(project, ["gsc", "ga4"]);
  if (project.posthogProject) await queuePosthogSync(scope, project.posthogProject);
  if (project.plausibleSite) await queuePlausibleSync(scope, project.plausibleSite);
  if (project.umamiSite) await queueUmamiSync(scope, project.umamiSite);
  refresh();
}

export async function disconnectGoogle() {
  await requireSession();
  const { workspaceId } = await workspaceScope();
  const res = await disconnectAccount(workspaceId);
  if (!res.ok) redirect("/gsc?google_error=disconnect_failed");
  forgetGoogleProperties(workspaceId);
  refresh();
}

const optional = z
  .string()
  .trim()
  .transform((s) => s || null);

/**
 * The workspace's own Search Console sites and GA4 properties. A mapping must name one of these,
 * so a workspace can't point a project at a property only another workspace's account can read.
 */
async function ownProperties(workspaceId: number): Promise<{ gsc: Set<string>; ga4: Set<string> }> {
  try {
    const { sites, ga4 } = await listGoogleProperties(workspaceId);
    return { gsc: new Set(sites.map((s) => s.siteUrl)), ga4: new Set(ga4.map((g) => g.property)) };
  } catch {
    // Not connected: only clearing a mapping is possible.
    return { gsc: new Set(), ga4: new Set() };
  }
}

/** Saves a project's GSC and GA4 properties. A changed property drops that source's data and resyncs. */
export async function setProjectProperties(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { project: p, scope } = await requireProject(projectId);
  const gscProperty = optional.parse(formData.get("gscProperty") ?? "");
  const ga4Property = optional.parse(formData.get("ga4Property") ?? "");
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  if (gscProperty !== p.gscProperty || ga4Property !== p.ga4Property) {
    const own = await ownProperties(scope.workspaceId);
    if ((gscProperty && gscProperty !== p.gscProperty && !own.gsc.has(gscProperty)) || (ga4Property && ga4Property !== p.ga4Property && !own.ga4.has(ga4Property))) {
      return { error: "That property isn't on this workspace's Google account. Pick another, or reconnect Google." };
    }
  }
  // Analytics comes from one source at a time: picking a GA4 property drops a PostHog, Plausible or Umami mapping and its rows.
  const dropPosthog = !!ga4Property && !!p.posthogProject;
  const dropPlausible = !!ga4Property && !!p.plausibleSite;
  const dropUmami = !!ga4Property && !!p.umamiSite;
  await db
    .update(projects)
    .set({ gscProperty, ga4Property, ...(dropPosthog ? { posthogProject: null } : {}), ...(dropPlausible ? { plausibleSite: null } : {}), ...(dropUmami ? { umamiSite: null } : {}) })
    .where(projectRow(scope));
  if (dropPosthog) await resetPosthogData(scope);
  if (dropPlausible) await resetPlausibleData(scope);
  if (dropUmami) await resetUmamiData(scope);
  const changed: Source[] = [];
  if (p.gscProperty !== gscProperty) changed.push("gsc");
  if (p.ga4Property !== ga4Property) changed.push("ga4");
  for (const s of changed) await resetGoogleData(scope, s);
  // A plan may count the Search Console site and GA4 property (getseopen.com: one trial each).
  await hooks.connected(scope.workspaceId, { gscProperty, ga4Property });
  await queueSync({ ...p, gscProperty, ga4Property }, changed);
  refresh();
}

/** Applies every suggested mapping to projects that have none yet. */
export async function applySuggestions(formData: FormData) {
  await requireSession();
  const pairs = z.array(z.object({ id: z.number(), gsc: z.string().nullable(), ga4: z.string().nullable() })).parse(JSON.parse(String(formData.get("suggestions") ?? "[]")));
  const { workspaceId } = await workspaceScope();
  const own = await ownProperties(workspaceId);
  // Only this workspace's projects; another workspace's id matches nothing.
  const mine = new Map((await listProjects()).map((p) => [p.id, p]));
  for (const s of pairs) {
    const p = mine.get(s.id);
    if (!p) continue;
    // A project that is read-only after a downgrade keeps its mapping, as in setProjectProperties.
    if (await projectActionRefusal(projectScope(p))) continue;
    const gsc = s.gsc && own.gsc.has(s.gsc) ? s.gsc : null;
    // A project on PostHog, Plausible or Umami keeps it; a GA4 suggestion would replace its Analytics source.
    const ga4 = s.ga4 && own.ga4.has(s.ga4) && !p.posthogProject && !p.plausibleSite && !p.umamiSite ? s.ga4 : null;
    const set = { gscProperty: p.gscProperty ?? gsc, ga4Property: p.ga4Property ?? ga4 };
    await db.update(projects).set(set).where(projectRow(projectScope(p)));
    await hooks.connected(workspaceId, { gscProperty: set.gscProperty, ga4Property: set.ga4Property });
    await queueSync({ ...p, ...set }, ["gsc", "ga4"].filter((src) => (src === "gsc" ? !p.gscProperty && gsc : !p.ga4Property && ga4)) as Source[]);
  }
  refresh();
}

export type ImportState = { message: string; ok: boolean } | null;

/**
 * Creates a project for each Search Console property the user ticked in the import picker, with
 * the GA4 property chosen next to it, and starts their syncs. The plan is rebuilt from a fresh
 * property list, so a stale or edited form can't import a site twice or one the account lost.
 */
export async function importFromSearchConsole(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const user = await requireSession();
  const selected = formData.getAll("site").map(String);
  if (!selected.length) return { ok: false, message: "Tick at least one site to import." };
  const { workspaceId } = await workspaceScope();
  const [{ sites, ga4 }, existing] = await Promise.all([listGoogleProperties(workspaceId, true), listProjects()]);
  const allPicks = selectImports(planImport(existing, sites.filter(usableSite)), selected, (siteUrl) => String(formData.get(`ga4:${siteUrl}`) ?? "") || null, ga4);
  // Only as many as the plan has room for; the message says how many were left out.
  const ws = await loadBillingWorkspace(workspaceId);
  const picks: typeof allPicks = [];
  let siteTaken: string | null = null;
  let sitesTaken = 0;
  for (const item of allPicks) {
    if (!(await projectGate(ws)).ok) break;
    const domain = normalizeDomain(item.domain);
    // A site the plan won't take (getseopen.com: one another Free workspace has) stays out.
    const taken = await hooks.siteRefusal(workspaceId, domain);
    if (taken) {
      siteTaken ??= taken.message;
      sitesTaken++;
      continue;
    }
    picks.push(item);
    const [row] = await db
      .insert(projects)
      .values({ workspaceId, name: domain, domain, gscProperty: item.siteUrl, ga4Property: item.ga4Property })
      .returning();
    if (!isInternal(ws)) await db.insert(rankSettings).values({ workspaceId, projectId: row.id, dailyDepth: SAAS_DAILY_DEPTH }).onConflictDoNothing();
    await hooks.connected(workspaceId, { domain, gscProperty: item.siteUrl, ga4Property: item.ga4Property });
    await queueSync(row, item.ga4Property ? ["gsc", "ga4"] : ["gsc"]);
    track(user.id, "project_created", { project_id: row.id, source: "search_console", competitors: 0 }, { workspaceId });
  }
  const overLimit = allPicks.length - picks.length - sitesTaken;
  refresh();
  const skipped = selected.length - allPicks.length;
  return {
    ok: picks.length > 0,
    message: `Imported ${picks.length} project${picks.length === 1 ? "" : "s"}${skipped ? `; ${skipped} skipped (already a project or no longer on this account)` : ""}${overLimit ? `; ${overLimit} not imported: your plan's project limit is reached` : ""}.${picks.length || !siteTaken ? " Their history syncs in the background." : ""}${siteTaken ? ` ${siteTaken}` : ""}`,
  };
}

/** A failed inspection comes back to the form in plain words and leaves no row behind: the history is Google's verdicts. */
export async function inspectUrl(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const url = z.url().parse(String(formData.get("url") ?? "").trim());
  const { project: p, scope } = await requireProject(projectId);
  if (!p.gscProperty) return;
  // Google answers these with a 403 that reads like lost access, so they never reach it.
  if (!urlInProperty(url, p.gscProperty)) return { error: "That URL isn't in this property." };
  try {
    const api = await googleApis(scope.workspaceId);
    const r = await api.gsc.inspect(p.gscProperty, url);
    await saveInspection(scope, url, r);
  } catch (err) {
    console.error("[google.inspect]", err);
    return { error: inspectFailureMessage(err) };
  }
  refresh();
}
