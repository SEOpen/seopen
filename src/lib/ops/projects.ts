import { domainToASCII } from "node:url";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { aiPrompts, competitors, projects, rankKeywords, rankSettings } from "@/db/schema";
import { track } from "@/lib/analytics/server";
import { isInternal } from "@/lib/billing/gates";
import { keywordGate, loadBillingWorkspace, projectActionRefusal, projectGate, promptGate, SAAS_DAILY_DEPTH } from "@/lib/billing/workspace";
import { LOCATIONS, locationName } from "@/lib/dataforseo/locations";
import { cityInMarket } from "@/lib/dataforseo/places";
import { normalizeDomain } from "@/lib/projects";
import { inScope, type ProjectScope, type WorkspaceScope } from "@/lib/workspace";
import { anyCheckRunning } from "@/lib/workspace/running";
import { OpError, plural, refused, type Actor, type OpOptions } from ".";
import { hooks } from "@/plan-policy/hooks";

/** A registrable host name: labels of letters, digits and hyphens, ending in a letter TLD (or punycode). */
const PROJECT_DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** A site's domain from what someone typed (a URL, uppercase, www.), in ASCII; null if it isn't a public domain. */
export function projectDomain(input: string): string | null {
  const domain = domainToASCII(normalizeDomain(input));
  return PROJECT_DOMAIN.test(domain) ? domain : null;
}

/** A project's fields. The name is optional and defaults to the domain. Messages are shown to the user as is. */
export const projectInput = z
  .object({
    name: z.string().trim().max(80, "Keep the name to 80 characters or fewer.").optional().default(""),
    domain: z.string().transform((value, ctx) => {
      const domain = projectDomain(value);
      if (!domain) {
        ctx.addIssue({ code: "custom", message: value.trim() ? `"${value.trim().slice(0, 60)}" isn't a website address. Enter one such as example.com.` : "Enter your website's address, such as example.com." });
        return z.NEVER;
      }
      return domain;
    }),
    locationCode: z.coerce.number({ error: "Pick a country." }).int().positive("Pick a country."),
    languageCode: z.string().trim().min(2, "Pick a language.").max(8, "Pick a language."),
    /** A city in that country, or "" for the whole country. Left out, it stays as it was. */
    cityCode: z
      .preprocess((v) => (v === "" || v === "0" ? null : v), z.coerce.number().int().positive("Pick a city from the list.").nullable())
      .optional(),
  })
  .transform((v) => ({ ...v, name: v.name || v.domain }));

/** The first problem with a project's fields, worded for the user. */
export const projectInputError = (error: z.ZodError) => error.issues[0]?.message ?? "Check the fields and try again.";

export type ProjectInput = z.input<typeof projectInput>;

/**
 * The city columns for a project's fields, from the code they came with. A code is only taken if
 * it's a city of that country. Changing the country without naming a city clears the city.
 */
export async function projectCity(
  input: { locationCode: number; cityCode?: number | null },
  existing?: { locationCode: number; cityCode: number | null; cityName: string | null },
): Promise<{ cityCode: number | null; cityName: string | null }> {
  const same = existing?.locationCode === input.locationCode;
  const code = input.cityCode === undefined ? (same ? (existing?.cityCode ?? null) : null) : input.cityCode;
  if (code == null) return { cityCode: null, cityName: null };
  if (same && code === existing?.cityCode) return { cityCode: code, cityName: existing.cityName };
  const city = await cityInMarket(code, input.locationCode);
  if (!city) throw new OpError(`Pick a city in ${locationName(input.locationCode)} from the list.`);
  return { cityCode: city.code, cityName: city.name };
}

/** Competitor domains from free text or a list: normalised, deduped, the project's own domain and anything that isn't a website address left out. */
export function competitorDomains(raw: string | string[], own: string): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((r) => r.split(/[\s,]+/));
  return [...new Set(parts.map(projectDomain).filter((d): d is string => !!d && d !== own))];
}

/** What a typed competitor list holds: the addresses to add, and what was left out and why. */
export function sortCompetitorInput(raw: string, own: string): { domains: string[]; invalid: string[]; ownSite: boolean } {
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const invalid = parts.filter((p) => !projectDomain(p));
  return { domains: competitorDomains(parts, own), invalid, ownSite: parts.some((p) => projectDomain(p) === own) };
}

/** A market by its location code, or the market whose name matches (case-insensitive). */
export function findMarket(ref: string | number) {
  const text = String(ref).trim().toLowerCase();
  return LOCATIONS.find((l) => String(l.code) === text || l.name.toLowerCase() === text) ?? null;
}

export interface CreatedProject {
  dryRun: boolean;
  /** Null on a dry run. */
  projectId: number | null;
  domain: string;
  competitors: string[];
  message: string;
}

/**
 * Creates a project (a site) in the workspace, within the plan's project limit, with its
 * competitors. Customer projects track rank at depth 10. The plan policy may refuse the site first
 * (`siteRefusal`) and is told about it once it's added (`connected`), as in the app.
 */
export async function createProjectOp(
  ws: WorkspaceScope,
  actor: Actor,
  input: ProjectInput & { competitors?: string | string[] },
  opts: OpOptions = {},
): Promise<CreatedProject> {
  const parsed = projectInput.safeParse(input);
  if (!parsed.success) throw new OpError(projectInputError(parsed.error));
  const values = parsed.data;
  const city = await projectCity(values);
  const comps = competitorDomains(input.competitors ?? [], values.domain);
  const billing = await loadBillingWorkspace(ws.workspaceId);
  const gate = await projectGate(billing);
  if (!gate.ok) throw new OpError(gate.message);
  const siteTaken = await hooks.siteRefusal(ws.workspaceId, values.domain, { dryRun: opts.dryRun });
  if (siteTaken) throw refused(siteTaken);
  if (opts.dryRun) {
    const also = comps.length ? `, with ${plural(comps.length, "competitor")}` : "";
    return { dryRun: true, projectId: null, domain: values.domain, competitors: comps, message: `Would create the project ${values.name} (${values.domain})${also}.` };
  }
  let row: { id: number };
  try {
    [row] = await db
      .insert(projects)
      .values({ ...values, ...city, workspaceId: ws.workspaceId })
      .returning({ id: projects.id });
  } catch (err) {
    // The site may have been claimed for a project that didn't get made.
    await hooks.sitesChanged(ws.workspaceId);
    throw err;
  }
  // Customer projects track to depth 10 (one keyword unit); the owner's keep the module default.
  if (!isInternal(billing)) await db.insert(rankSettings).values({ workspaceId: ws.workspaceId, projectId: row.id, dailyDepth: SAAS_DAILY_DEPTH }).onConflictDoNothing();
  await hooks.connected(ws.workspaceId, { domain: values.domain });
  if (comps.length) {
    await db
      .insert(competitors)
      .values(comps.map((domain) => ({ workspaceId: ws.workspaceId, projectId: row.id, domain })))
      .onConflictDoNothing();
  }
  track(actor.userId, "project_created", { project_id: row.id, source: actor.source === "mcp" ? "mcp" : "form", competitors: comps.length }, { workspaceId: ws.workspaceId });
  return { dryRun: false, projectId: row.id, domain: values.domain, competitors: comps, message: `Created the project ${values.name} (${values.domain}).` };
}

export interface RestoredProject {
  dryRun: boolean;
  message: string;
}

/**
 * Brings an archived project back with its data. It counts against the plan like a new project,
 * and its active keywords and prompts count again too, so each has to fit. The plan policy may
 * refuse its site, as for a new project.
 */
export async function restoreProjectOp(scope: ProjectScope, opts: OpOptions = {}): Promise<RestoredProject> {
  const [project] = await db
    .select({ name: projects.name, archived: projects.archived, domain: projects.domain })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) throw new OpError("No such project in this workspace.");
  if (!project.archived) throw new OpError(`${project.name} isn't archived.`);
  const ws = await loadBillingWorkspace(scope.workspaceId);
  const [[keywords], [prompts]] = await Promise.all([
    db.select({ n: count() }).from(rankKeywords).where(and(inScope(rankKeywords, scope), eq(rankKeywords.active, true))),
    db.select({ n: count() }).from(aiPrompts).where(and(inScope(aiPrompts, scope), eq(aiPrompts.active, true))),
  ]);
  const checks: [string, () => ReturnType<typeof projectGate>][] = [
    ["", () => projectGate(ws)],
    [`It tracks ${plural(keywords.n, "keyword")}. `, () => keywordGate(ws, scope.projectId, keywords.n)],
    [`It asks ${plural(prompts.n, "AI prompt")}. `, () => promptGate(ws, prompts.n)],
  ];
  for (const [why, gate] of checks) {
    const result = await gate();
    if (!result.ok) throw new OpError(`Can't restore ${project.name}: ${why}${result.message}`);
  }
  const siteTaken = await hooks.siteRefusal(scope.workspaceId, project.domain, { dryRun: opts.dryRun });
  if (siteTaken) throw new OpError(`Can't restore ${project.name}: ${siteTaken.message}`, siteTaken);
  if (opts.dryRun) return { dryRun: true, message: `Would restore ${project.name}.` };
  await db.update(projects).set({ archived: false }).where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  return { dryRun: false, message: `Restored ${project.name}.` };
}

/**
 * Permanently deletes an archived project and everything stored under it. The word "delete" has to
 * be typed to confirm it. Archiving comes first so its schedules have stopped, and a check still running
 * refuses, since it would go on writing to the project. The spend ledger keeps its rows, without the
 * project, so totals and bills don't change. The plan policy hears the workspace's sites changed.
 * Only for a person in the app: no MCP tool can call this.
 */
export async function deleteProjectOp(scope: ProjectScope, actor: Actor, typed: string, opts: OpOptions = {}): Promise<RestoredProject> {
  const where = and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId));
  const [project] = await db.select({ name: projects.name, archived: projects.archived }).from(projects).where(where);
  if (!project) throw new OpError("No such project in this workspace.");
  if (!project.archived) throw new OpError(`Archive ${project.name} before deleting it.`);
  if (typed.trim().toLowerCase() !== "delete") throw new OpError("Type delete to confirm.");
  if (await anyCheckRunning(scope)) throw new OpError(`A check is still running on ${project.name}. Delete it once that finishes.`);
  if (opts.dryRun) return { dryRun: true, message: `Would delete ${project.name}.` };
  await db.delete(projects).where(where);
  await hooks.sitesChanged(scope.workspaceId);
  track(actor.userId, "project_deleted", { project_id: scope.projectId }, { workspaceId: scope.workspaceId });
  return { dryRun: false, message: `Deleted ${project.name}.` };
}

export interface AddedCompetitors {
  dryRun: boolean;
  added: string[];
  already: string[];
  message: string;
}

/** Adds competitor domains to a project. Domains it already has are left as they are. */
export async function addCompetitorsOp(scope: ProjectScope, domains: string | string[], opts: OpOptions = {}): Promise<AddedCompetitors> {
  const refusal = await projectActionRefusal(scope);
  if (refusal) throw refused(refusal);
  const [project] = await db
    .select({ domain: projects.domain })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  const wanted = competitorDomains(domains, project?.domain ?? "");
  if (!wanted.length) throw new OpError("Give at least one competitor domain, such as example.com.");
  const have = new Set(
    (
      await db
        .select({ domain: competitors.domain })
        .from(competitors)
        .where(and(eq(competitors.workspaceId, scope.workspaceId), eq(competitors.projectId, scope.projectId)))
    ).map((c) => c.domain),
  );
  const added = wanted.filter((d) => !have.has(d));
  const already = wanted.filter((d) => have.has(d));
  if (!opts.dryRun && added.length) {
    await db
      .insert(competitors)
      .values(added.map((domain) => ({ ...scope, domain })))
      .onConflictDoNothing();
  }
  const verb = opts.dryRun ? "Would add" : "Added";
  const parts = [`${verb} ${plural(added.length, "competitor")}`];
  if (already.length) parts.push(`${already.length} already there`);
  return { dryRun: !!opts.dryRun, added, already, message: `${parts.join(" · ")}.` };
}
