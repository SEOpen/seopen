"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { backlinksDomainDecisions } from "@/db/schema";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { requireSession } from "@/lib/auth/session";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { BudgetExceededError, DataForSEOError, SpendRefusedError } from "@/lib/dataforseo/client";
import { requireProject } from "@/lib/projects";
import { workspaceScope } from "@/lib/workspace/current";
import { getNewLost, getSummary } from "./api";

const decisionInput = z.object({
  projectId: z.number().int().positive(),
  domain: z.string().trim().min(3).max(255),
  decision: z.enum(["keep", "disavow", "clear"]),
  note: z.string().max(500).optional(),
});

/** Mark a linking domain keep or disavow for a project; "clear" removes the decision. */
export async function setDomainDecision(input: z.input<typeof decisionInput>): Promise<ActionResult> {
  await requireSession();
  const { projectId, domain, decision, note } = decisionInput.parse(input);
  const { scope } = await requireProject(projectId);
  const locked = await projectActionRefusal(scope);
  if (locked) return refusalResult(locked);
  const d = domain.toLowerCase();
  if (decision === "clear") {
    await db
      .delete(backlinksDomainDecisions)
      .where(
        and(
          eq(backlinksDomainDecisions.workspaceId, scope.workspaceId),
          eq(backlinksDomainDecisions.projectId, scope.projectId),
          eq(backlinksDomainDecisions.domain, d),
        ),
      );
  } else {
    await db
      .insert(backlinksDomainDecisions)
      .values({ ...scope, domain: d, decision, note })
      .onConflictDoUpdate({
        target: [backlinksDomainDecisions.projectId, backlinksDomainDecisions.domain],
        set: { decision, note, updatedAt: new Date() },
      });
  }
  refresh();
}

/**
 * Re-fetch the overview's summary and new/lost series, bypassing the cache (≈ $0.05). A refusal or
 * a failed lookup comes back as the reason, and what's stored stays on the page.
 */
export async function refreshOverview(target: string, projectId: number | null): Promise<ActionResult> {
  await requireSession();
  const t = z.string().trim().min(3).max(255).parse(target);
  // A project id is only for the ledger; it must be one of this workspace's projects.
  const opts = projectId ? (await requireProject(projectId)).scope : await workspaceScope();
  const results = await Promise.allSettled([getSummary(t, { ...opts, force: true }), getNewLost(t, { ...opts, force: true })]);
  // One may have worked and been paid for, so the page and the credits left still update.
  if (results.some((r) => r.status === "fulfilled")) refresh();
  const failed = results.find((r) => r.status === "rejected");
  if (failed) return refreshFailure(failed.reason);
}

function refreshFailure(e: unknown): ActionResult {
  if (e instanceof SpendRefusedError) return refusalResult(e.refusal);
  // A bare cap error only reaches the owner's workspace, which sees dollars.
  if (e instanceof BudgetExceededError) return { error: e.message };
  if (e instanceof DataForSEOError) {
    console.error("[backlinks] refresh failed", e);
    return { error: "The refresh didn't finish because the backlink lookup failed. Try again in a few minutes." };
  }
  throw e;
}
