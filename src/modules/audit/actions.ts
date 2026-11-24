"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { lighthouseRefusal, loadBillingWorkspace, projectActionRefusal } from "@/lib/billing/workspace";
import { plainCrawlFailure } from "@/lib/dataforseo/failure-copy";
import { enqueue } from "@/lib/jobs/boss";
import { OpError } from "@/lib/ops";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { activeCrawl, failLighthouse, LIGHTHOUSE_ALREADY_QUEUED, MAX_PAGES_LIMIT, queueLighthouse, saveSettings, stopCrawl } from "./crawl";
import { startCrawlOp } from "./ops";
import { requireSession } from "@/lib/auth/session";

const crawlInput = z.object({
  maxPages: z.coerce.number().int().min(1).max(MAX_PAGES_LIMIT),
  enableJavascript: z.literal("on").optional(),
});

export interface ActionState {
  error?: string;
  /** A refusal that Upgrade now would lift. */
  upgradable?: boolean;
}

/** The current project (of the current workspace) and its scope. */
async function requireProject() {
  const project = await getCurrentProject();
  if (!project) throw new Error("Create a project first.");
  return { project, scope: projectScope(project) };
}

export async function startCrawl(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireSession();
  const parsed = crawlInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: `Max pages must be between 1 and ${MAX_PAGES_LIMIT}.` };
  const { project } = await requireProject();
  try {
    await startCrawlOp(project, { userId: user.id, source: "app" }, { maxPages: parsed.data.maxPages, enableJavascript: parsed.data.enableJavascript === "on" });
  } catch (err) {
    if (err instanceof OpError) return err.refusal ? refusalResult(err.refusal) : { error: err.message };
    // Not written for the customer (a failed save or enqueue, say): the raw text stays in the logs.
    console.error("[audit] crawl not started:", err);
    return { error: plainCrawlFailure(null).message };
  }
  refresh();
  return {};
}

export async function stopActiveCrawl() {
  await requireSession();
  const { scope } = await requireProject();
  const crawl = await activeCrawl(scope);
  if (crawl) await stopCrawl(crawl);
  refresh();
}

export async function setWeekly(enabled: boolean): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject();
  if (enabled) {
    const refusal = await projectActionRefusal(scope);
    if (refusal) return refusalResult(refusal);
  }
  await saveSettings(scope, { weeklyEnabled: enabled });
  refresh();
}

export async function startLighthouse(): Promise<ActionResult> {
  await requireSession();
  const { project, scope } = await requireProject();
  const refusal = (await projectActionRefusal(scope, { paid: true })) ?? lighthouseRefusal(await loadBillingWorkspace(scope.workspaceId));
  if (refusal) return refusalResult(refusal);
  const id = await queueLighthouse(scope, `https://${project.domain}/`);
  if (id === null) return { error: LIGHTHOUSE_ALREADY_QUEUED };
  try {
    await enqueue("audit.lighthouse", { ...scope, lighthouseId: id });
  } catch (err) {
    // Free the slot so the next click can try again; the raw text stays in the logs.
    console.error("[audit] lighthouse not queued:", err);
    await failLighthouse(scope, id, "Not queued");
    return { error: "The Lighthouse test couldn't be queued. Try again in a minute." };
  }
  refresh();
}
