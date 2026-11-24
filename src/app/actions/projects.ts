"use server";

import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { competitors, projects } from "@/db/schema";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { isFree } from "@/lib/billing/gates";
import { loadBillingWorkspace, LOCKED_REFUSAL, projectLocked } from "@/lib/billing/workspace";
import { trackedLocation, trackedPlaceName } from "@/lib/dataforseo/locations";
import { OpError } from "@/lib/ops";
import { addCompetitorsOp, competitorDomains, createProjectOp, deleteProjectOp, projectCity, projectInput, projectInputError, restoreProjectOp, sortCompetitorInput } from "@/lib/ops/projects";
import type { ProjectFormState } from "@/components/project-form";
import { PROJECT_COOKIE_OPTIONS } from "@/lib/project-cookie";
import { PROJECT_COOKIE, requireProject } from "@/lib/projects";
import { workspaceScope } from "@/lib/workspace/current";
import { startCrawlOp } from "@/modules/audit/ops";
import { chosenLinks, SOURCE_FIELD } from "@/modules/analytics-source/match";
import { setProjectProperties } from "@/modules/google/actions";
import { setPlausibleSite } from "@/modules/plausible/actions";
import { setPosthogProject } from "@/modules/posthog/actions";
import { setUmamiSite } from "@/modules/umami/actions";
import { rankPlaceChanged } from "@/modules/rank/ops";
import { requireSession } from "@/lib/auth/session";
import { hooks } from "@/plan-policy/hooks";

export async function selectProject(id: number) {
  await requireSession();
  // Only a live project of this workspace can be selected, as the switcher lists; getCurrentProject also ignores any other id.
  const { project } = await requireProject(id);
  if (project.archived) notFound();
  (await cookies()).set(PROJECT_COOKIE, String(id), PROJECT_COOKIE_OPTIONS);
  refresh();
}

/** Every field as typed, so the form can show them again after an error. */
const typed = (formData: FormData) => Object.fromEntries([...formData].filter(([k, v]) => typeof v === "string" && !k.startsWith("$")).map(([k, v]) => [k, String(v)]));

/**
 * Links the Search Console site and the Analytics source chosen on the new project form, and starts
 * their sync. A project takes Analytics from one source, so only the field of the source the switch
 * was on counts (GA4 when the form sent none). The project exists by now, so a failure stays out of
 * the form: an error there would invite creating it a second time. The project opens unlinked, and
 * can be linked from Search Console or Analytics.
 */
async function linkChosenProperties(projectId: number, formData: FormData) {
  const { gscProperty, ga4Property, other } = chosenLinks(formData);
  const link = async (what: string, run: () => Promise<{ error: string } | void>) => {
    try {
      const refused = await run();
      if (refused) console.error(`[project.create] linking ${what} refused:`, refused.error);
    } catch (e) {
      console.error(`[project.create] linking ${what} failed:`, e);
    }
  };
  if (gscProperty || ga4Property) {
    const google = new FormData();
    google.set("gscProperty", gscProperty);
    google.set("ga4Property", ga4Property);
    await link("Google properties", () => setProjectProperties(projectId, google));
  }
  if (!other) return;
  const fd = new FormData();
  fd.set(SOURCE_FIELD[other.source], other.value);
  const set = { PostHog: setPosthogProject, Plausible: setPlausibleSite, Umami: setUmamiSite }[other.source];
  await link(other.source, () => set(projectId, fd));
}

/** New project form: an error comes back to the form with what was typed; success opens the project (or its setup). */
export async function createProjectFromForm(_prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  const user = await requireSession();
  const { workspaceId } = await workspaceScope();
  let created;
  try {
    created = await createProjectOp(
      { workspaceId },
      { userId: user.id, source: "app" },
      {
        name: String(formData.get("name") ?? ""),
        domain: String(formData.get("domain") ?? ""),
        locationCode: String(formData.get("locationCode") ?? ""),
        languageCode: String(formData.get("languageCode") ?? ""),
        cityCode: String(formData.get("cityCode") ?? ""),
        competitors: String(formData.get("competitors") ?? ""),
      },
    );
  } catch (e) {
    if (e instanceof OpError) return { error: e.message, values: typed(formData) };
    throw e;
  }
  if (created.projectId) await linkChosenProperties(created.projectId, formData);
  (await cookies()).set(PROJECT_COOKIE, String(created.projectId), PROJECT_COOKIE_OPTIONS);
  if (formData.get("next") === "audit" && created.projectId) {
    await auditNewProject(created.projectId, user.id);
    redirect("/audit");
  }
  // Guided setup comes with a paid plan, so a Free workspace goes straight to its new project.
  const setup = formData.get("next") === "setup" && !isFree(await loadBillingWorkspace(workspaceId));
  redirect(setup ? `/projects/${created.projectId}/setup` : `/projects/${created.projectId}`);
}

/**
 * Create and audit: starts the new project's first crawl through Start crawl's op, so the same gates
 * apply (the week's audit on Free, the ceiling, a confirmed email). The project exists by now, so a
 * refusal stays out of the form, as a failed property link does. Site audit, where it lands, shows
 * the crawl or why none could start.
 */
async function auditNewProject(projectId: number, userId: string) {
  try {
    const { project } = await requireProject(projectId);
    await startCrawlOp(project, { userId, source: "app" }, {});
  } catch (e) {
    if (e instanceof OpError) console.info("[project.create] audit not started:", e.message);
    else console.error("[project.create] audit not started:", e);
  }
}

/** Project settings form: saves, or returns the problem with what was typed. */
export async function saveProjectFromForm(id: number, _prev: ProjectFormState, formData: FormData): Promise<ProjectFormState> {
  await requireSession();
  const parsed = projectInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: projectInputError(parsed.error), values: typed(formData) };
  const input = parsed.data;
  const { project, scope } = await requireProject(id);
  const ws = await loadBillingWorkspace(scope.workspaceId);
  if (await projectLocked(ws, scope.projectId)) return { error: LOCKED_REFUSAL.message, values: typed(formData) };
  let city;
  try {
    city = await projectCity(input, project);
  } catch (e) {
    if (e instanceof OpError) return { error: e.message, values: typed(formData) };
    throw e;
  }
  // A new site goes to the plan policy first, which may refuse it.
  const newSite = input.domain !== project.domain;
  if (newSite) {
    const taken = await hooks.siteRefusal(scope.workspaceId, input.domain);
    if (taken) return { error: taken.message, values: typed(formData) };
  }
  await db
    .update(projects)
    .set({ ...input, ...city })
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (newSite) await hooks.sitesChanged(scope.workspaceId);
  await hooks.connected(scope.workspaceId, { domain: input.domain });
  const after = { locationCode: input.locationCode, ...city };
  const moved = trackedLocation(after) !== trackedLocation(project);
  if (moved) await rankPlaceChanged(scope);
  refresh();
  return { saved: true, movedTo: moved ? trackedPlaceName(after) : undefined };
}

export async function archiveProject(id: number) {
  await requireSession();
  const { scope } = await requireProject(id);
  await db
    .update(projects)
    .set({ archived: true })
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  // An archived project can't audit: a plan that counts sites lets this one go.
  await hooks.sitesChanged(scope.workspaceId);
  redirect("/");
}

export type RestoreState = { error: string } | null;

/** Restores an archived project and opens its dashboard; a plan refusal comes back as `error`. */
export async function restoreProject(id: number): Promise<RestoreState> {
  await requireSession();
  const { scope } = await requireProject(id);
  try {
    await restoreProjectOp(scope);
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  (await cookies()).set(PROJECT_COOKIE, String(id), PROJECT_COOKIE_OPTIONS);
  redirect(`/projects/${id}`);
}

export type DeleteState = { error: string } | null;

/** Permanently deletes an archived project once "delete" is typed, and goes to the projects list; a refusal comes back as `error`. */
export async function deleteProject(id: number, _prev: DeleteState, formData: FormData): Promise<DeleteState> {
  const user = await requireSession();
  const { scope } = await requireProject(id);
  try {
    await deleteProjectOp(scope, { userId: user.id, source: "app" }, String(formData.get("confirm") ?? ""));
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  const jar = await cookies();
  if (jar.get(PROJECT_COOKIE)?.value === String(id)) jar.delete(PROJECT_COOKIE);
  redirect("/");
}

export async function addCompetitor(projectId: number, formData: FormData): Promise<ActionResult> {
  await requireSession();
  const { project, scope } = await requireProject(projectId);
  const raw = String(formData.get("domain") ?? "");
  if (competitorDomains(raw, project.domain).length) {
    try {
      await addCompetitorsOp(scope, raw);
    } catch (e) {
      if (e instanceof OpError) return e.refusal ? refusalResult(e.refusal) : { error: e.message };
      throw e;
    }
  }
  refresh();
}

export type CompetitorFormState = { message?: string; error?: string; value?: string } | null;

/** The settings form's add: says what was added and what was skipped, and keeps the text when nothing fit. */
export async function addCompetitorsFromForm(projectId: number, _prev: CompetitorFormState, formData: FormData): Promise<CompetitorFormState> {
  await requireSession();
  const { project, scope } = await requireProject(projectId);
  const raw = String(formData.get("domain") ?? "");
  const { domains, invalid, ownSite } = sortCompetitorInput(raw, project.domain);
  const skipped = [
    invalid.length ? `${invalid.slice(0, 3).map((p) => `"${p.slice(0, 40)}"`).join(", ")}${invalid.length > 3 ? ` and ${invalid.length - 3} more` : ""} ${invalid.length === 1 ? "isn't a website address" : "aren't website addresses"}` : null,
    ownSite ? `${project.domain} is this project's own site` : null,
  ].filter(Boolean);
  if (!domains.length) return { error: skipped.length ? `Nothing added: ${skipped.join("; ")}.` : "Enter a competitor's website, such as example.com.", value: raw };
  try {
    const { message } = await addCompetitorsOp(scope, domains);
    refresh();
    return { message: skipped.length ? `${message} Skipped: ${skipped.join("; ")}.` : message };
  } catch (e) {
    if (e instanceof OpError) return { error: e.message, value: raw };
    throw e;
  }
}

export async function removeCompetitor(projectId: number, domain: string) {
  await requireSession();
  const { scope } = await requireProject(projectId);
  await db
    .delete(competitors)
    .where(and(eq(competitors.workspaceId, scope.workspaceId), eq(competitors.projectId, scope.projectId), eq(competitors.domain, domain)));
  refresh();
}
