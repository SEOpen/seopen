import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { domainsTeardowns, type TeardownFinding, type TeardownMove } from "@/db/schema";
import { projects } from "@/db/schema/core";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { OpError, plural, refused, type OpOptions } from "@/lib/ops";
import type { ProjectScope } from "@/lib/workspace";
import { normalizeDomain } from "@/lib/projects";
import { isHostname } from "./transform";

/**
 * Saved competitor teardowns (`domains_teardowns`). An agent writes one with the MCP tool
 * `save_teardown`; Domains → Teardowns shows them. Nothing here spends: the research behind a
 * teardown was paid for when the agent looked it up.
 */

export const TEARDOWN_LIMITS = {
  summary: 2000,
  findings: 10,
  findingTitle: 120,
  findingBody: 2000,
  moves: 5,
  moveTitle: 200,
  moveWhy: 1000,
  moveFirstStep: 500,
  /** Teardowns a project keeps. Past it, a new one is refused rather than an old one deleted. */
  perProject: 100,
} as const;

export const MOVE_SIZES = ["page", "template", "project"] as const;

export interface SaveTeardownInput {
  domain: string;
  summary: string;
  findings: TeardownFinding[];
  moves: TeardownMove[];
  creditsSpent?: number;
  /** Where the research was measured; the project's own when left out. */
  market?: { locationCode: number; languageCode: string };
}

export interface SavedTeardown {
  dryRun: boolean;
  id: number | null;
  domain: string;
  /** Ids of the project's teardowns of the same domain saved before this one, newest first. */
  earlier: number[];
  message: string;
}

/** Trims, folds runs of spaces and tabs, keeps paragraph breaks, and drops control characters. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function need(value: string, label: string, max: number): string {
  const text = cleanText(value);
  if (!text) throw new OpError(`${label} can't be empty.`);
  if (text.length > max) throw new OpError(`${label} is ${text.length} characters; keep it to ${max}.`);
  return text;
}

/** Checks and cleans a teardown, throwing an OpError that names the first problem. */
export function parseTeardown(input: SaveTeardownInput): { domain: string; summary: string; findings: TeardownFinding[]; moves: TeardownMove[]; creditsSpent: number } {
  const domain = normalizeDomain(input.domain);
  if (!isHostname(domain)) throw new OpError(`“${input.domain}” isn't a domain, such as example.com.`);
  const L = TEARDOWN_LIMITS;
  if (input.findings.length > L.findings) throw new OpError(`Give at most ${L.findings} findings.`);
  if (!input.moves.length || input.moves.length > L.moves) throw new OpError(`Give 1 to ${L.moves} moves.`);
  return {
    domain,
    summary: need(input.summary, "The summary", L.summary),
    findings: input.findings.map((f, i) => ({ title: need(f.title, `Finding ${i + 1}'s title`, L.findingTitle), body: need(f.body, `Finding ${i + 1}`, L.findingBody) })),
    moves: input.moves.map((m, i) => {
      if (!(MOVE_SIZES as readonly string[]).includes(m.size)) throw new OpError(`Move ${i + 1}'s size is page, template or project.`);
      return { title: need(m.title, `Move ${i + 1}'s title`, L.moveTitle), why: need(m.why, `Move ${i + 1}'s why`, L.moveWhy), size: m.size, firstStep: need(m.firstStep, `Move ${i + 1}'s first step`, L.moveFirstStep) };
    }),
    creditsSpent: Math.max(0, Math.round(input.creditsSpent ?? 0)),
  };
}

export async function saveTeardownOp(scope: ProjectScope, input: SaveTeardownInput, opts: OpOptions & { savedBy?: string } = {}): Promise<SavedTeardown> {
  const refusal = await projectActionRefusal(scope);
  if (refusal) throw refused(refusal);
  const t = parseTeardown(input);

  const [project] = await db
    .select({ locationCode: projects.locationCode, languageCode: projects.languageCode })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) throw new OpError("That project wasn't found.");
  const market = input.market ?? project;

  const [{ n }] = await db.select({ n: count() }).from(domainsTeardowns).where(and(eq(domainsTeardowns.workspaceId, scope.workspaceId), eq(domainsTeardowns.projectId, scope.projectId)));
  if (n >= TEARDOWN_LIMITS.perProject) throw new OpError(`This project already keeps ${TEARDOWN_LIMITS.perProject} teardowns. Delete some on Domains → Teardowns first.`);

  // Saving again is allowed (a newer look), but say so, so a repeat isn't saved by accident.
  const earlier = (
    await db
      .select({ id: domainsTeardowns.id })
      .from(domainsTeardowns)
      .where(and(eq(domainsTeardowns.workspaceId, scope.workspaceId), eq(domainsTeardowns.projectId, scope.projectId), eq(domainsTeardowns.domain, t.domain)))
      .orderBy(desc(domainsTeardowns.createdAt), desc(domainsTeardowns.id))
  ).map((r) => r.id);
  const seen = earlier.length
    ? ` This project already has ${earlier.length === 1 ? "a teardown" : `${earlier.length} teardowns`} of ${t.domain} (${earlier.map((id) => `#${id}`).join(", ")}); this adds another.`
    : "";

  const what = `a teardown of ${t.domain}: ${plural(t.findings.length, "finding")} and ${plural(t.moves.length, "move")}`;
  if (opts.dryRun) return { dryRun: true, id: null, domain: t.domain, earlier, message: `Would save ${what}, shown on Domains → Teardowns.${seen}` };

  const [row] = await db
    .insert(domainsTeardowns)
    .values({ ...scope, ...t, locationCode: market.locationCode, languageCode: market.languageCode, savedBy: opts.savedBy?.slice(0, 100) ?? null })
    .returning({ id: domainsTeardowns.id });
  return { dryRun: false, id: row.id, domain: t.domain, earlier, message: `Saved ${what}. It's on Domains → Teardowns.${seen}` };
}

export type TeardownRow = typeof domainsTeardowns.$inferSelect;

/** The project's teardowns, newest first, with a count of their moves and the first move's title in place of the findings and moves. */
export async function listTeardowns(scope: ProjectScope) {
  return db
    .select({ id: domainsTeardowns.id, domain: domainsTeardowns.domain, summary: domainsTeardowns.summary, moves: sql<number>`jsonb_array_length(${domainsTeardowns.moves})`.mapWith(Number), topMove: sql<string | null>`${domainsTeardowns.moves}->0->>'title'`, locationCode: domainsTeardowns.locationCode, creditsSpent: domainsTeardowns.creditsSpent, savedBy: domainsTeardowns.savedBy, createdAt: domainsTeardowns.createdAt })
    .from(domainsTeardowns)
    .where(and(eq(domainsTeardowns.workspaceId, scope.workspaceId), eq(domainsTeardowns.projectId, scope.projectId)))
    .orderBy(desc(domainsTeardowns.createdAt), desc(domainsTeardowns.id))
    .limit(TEARDOWN_LIMITS.perProject);
}

export async function getTeardown(scope: ProjectScope, id: number): Promise<TeardownRow | null> {
  const [row] = await db
    .select()
    .from(domainsTeardowns)
    .where(and(eq(domainsTeardowns.id, id), eq(domainsTeardowns.workspaceId, scope.workspaceId), eq(domainsTeardowns.projectId, scope.projectId)));
  return row ?? null;
}

/** Deletes one of the project's teardowns. True when there was one to delete. */
export async function deleteTeardown(scope: ProjectScope, id: number): Promise<boolean> {
  const gone = await db
    .delete(domainsTeardowns)
    .where(and(eq(domainsTeardowns.id, id), eq(domainsTeardowns.workspaceId, scope.workspaceId), eq(domainsTeardowns.projectId, scope.projectId)))
    .returning({ id: domainsTeardowns.id });
  return gone.length > 0;
}
