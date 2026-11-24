"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { OpError } from "@/lib/ops";
import { requireProject } from "@/lib/projects";
import { currentWorkspace } from "@/lib/workspace/current";
import { applySetupOp, type SetupSelection, type StepResult } from "./apply";
import { BUSINESS_TYPES, MAX_SEARCHES, MAX_TOWNS, parseSearches, type SetupBusiness } from "./business";
import { gatherSetup, guessBusiness, guessSearches, savedBusiness, setupQuote, type SetupQuote } from "./gather";
import { plainProposal, type Proposal } from "./propose";
import { claudeSetupOpen, refineProposal } from "./refine.server";

export interface ProposeResult {
  proposal?: Proposal;
  /** What the homepage says the site is, shown above the checklist. */
  read?: { title: string | null; description: string | null };
  homepageError?: string | null;
  /** Claude's review (the owner's workspace only for now): its one-line read of the business, or why the plain proposal stands. */
  claude?: { summary: string | null } | { error: string };
  error?: string;
}

const businessSchema = z.object({
  type: z.enum(BUSINESS_TYPES),
  towns: z.array(z.string().trim().min(2).max(80)).max(MAX_TOWNS),
  searches: z
    .array(z.string().trim().min(2).max(80))
    .max(MAX_SEARCHES)
    .default([])
    .transform((searches) => parseSearches(searches.join("\n"))),
});

export interface BusinessRead {
  business: SetupBusiness;
  /** True when this is what the user confirmed before, not a guess from the site. */
  confirmed: boolean;
  /** The homepage was read for the guess. */
  read: boolean;
  quote: SetupQuote;
}

/** What the setup thinks the business is: the user's answer if it has one, else a free guess from the site. */
export async function readBusiness(projectId: number): Promise<BusinessRead> {
  await requireSession();
  const { project } = await requireProject(projectId);
  const saved = savedBusiness(project);
  if (saved) {
    // Answered before this question existed, or as a local business: the guess is still free.
    const business = project.setupSearches == null ? { ...saved, searches: await guessSearches(project, saved.type) } : saved;
    return { business, confirmed: true, read: true, quote: await setupQuote(project, business) };
  }
  const { read, ...business } = await guessBusiness(project);
  return { business, confirmed: false, read, quote: await setupQuote(project, business) };
}

/** What a proposal for this answer would cost, as the user changes it. Spends nothing. */
export async function quoteBusiness(projectId: number, raw: SetupBusiness): Promise<SetupQuote> {
  await requireSession();
  const { project } = await requireProject(projectId);
  return setupQuote(project, businessSchema.parse(raw));
}

/** Saves the user's answer about the business, runs the quoted lookups and returns the plain proposal. Changes nothing else in the project. */
export async function proposeSetup(projectId: number, raw: SetupBusiness): Promise<ProposeResult> {
  await requireSession();
  const { project, scope } = await requireProject(projectId);
  const business = businessSchema.parse(raw);
  const refusal = await projectActionRefusal(scope);
  if (refusal) return { error: refusal.message };
  try {
    await db
      .update(projects)
      // A local business's answer leaves the searches alone: it never saw them.
      .set({ businessType: business.type, servedTowns: business.towns, ...(business.type === "local" ? {} : { setupSearches: business.searches }) })
      .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
    const { input, homepageError, trackingCities } = await gatherSetup(project, business);
    refresh(); // the header's credits left
    const plain = plainProposal(input);
    let proposal: Proposal = plain;
    let claude: ProposeResult["claude"];
    const ws = await currentWorkspace();
    if (claudeSetupOpen(ws)) {
      const refined = await refineProposal(ws, scope, input, plain);
      if ("error" in refined) claude = { error: refined.error };
      else {
        const { summary, ...rest } = refined.proposal;
        proposal = rest;
        claude = { summary };
      }
    }
    return {
      proposal: { ...proposal, trackingCities },
      claude,
      read: input.site && (input.site.title || input.site.description) ? { title: input.site.title, description: input.site.description } : undefined,
      homepageError,
    };
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
}

/** Applies the ticked items. Each step reports on its own. */
export async function applySetup(projectId: number, selection: SetupSelection): Promise<{ results: StepResult[] }> {
  const user = await requireSession();
  const { project } = await requireProject(projectId);
  const results = await applySetupOp(project, { userId: user.id, source: "app" }, selection);
  refresh();
  return { results };
}
