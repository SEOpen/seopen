"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { settings, workspaceSettings, workspaces } from "@/db/schema";
import type { ActionResult } from "@/lib/action-result";
import { assertAdmin } from "@/lib/admin/access";
import { capError, OWNER_CAP_MAX, parseCap, PLATFORM_CAP_MAX } from "@/lib/billing/caps";
import { resumeLapsedPauses } from "@/lib/billing/jobs-gate";
import { PLATFORM_CAP_SETTING_KEY } from "@/lib/billing/spend";
import { enqueue } from "@/lib/jobs/boss";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";

/**
 * Sets the platform backstop: no workspace's paid calls run once DataForSEO's bill this month
 * reaches it. Jobs the cap paused start again if the new cap has room and each passes its own checks.
 */
export async function setPlatformCap(formData: FormData): Promise<ActionResult> {
  await assertAdmin();
  const cap = parseCap(formData.get("cap"), PLATFORM_CAP_MAX);
  if (cap == null) return { error: capError(PLATFORM_CAP_MAX) };
  await db
    .insert(settings)
    .values({ key: PLATFORM_CAP_SETTING_KEY, value: cap })
    .onConflictDoUpdate({ target: settings.key, set: { value: cap, updatedAt: new Date() } });
  try {
    await resumeLapsedPauses(enqueue, { platformOnly: true });
  } catch (err) {
    // The cap stands. The daily billing job tries the paused jobs again.
    console.error("[billing] couldn't resume paused jobs after saving the platform cap", err);
  }
  refresh();
}

/** The owner workspace's own monthly cap, from Admin → Spend (any admin, whichever workspace they work in). */
export async function setOwnerCap(formData: FormData): Promise<ActionResult> {
  await assertAdmin();
  const cap = parseCap(formData.get("cap"), OWNER_CAP_MAX);
  if (cap == null) return { error: capError(OWNER_CAP_MAX) };
  await db
    .insert(workspaceSettings)
    .values({ workspaceId: OWNER_WORKSPACE_ID, monthlyCapUsd: cap })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: { monthlyCapUsd: cap, updatedAt: new Date() } });
  refresh();
}

/** Suspends or restores a workspace from /admin. A suspended workspace's paid calls and jobs stop; its data stays. */
export async function setWorkspaceSuspended(formData: FormData) {
  await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("workspaceId"));
  const suspended = formData.get("suspended") === "1";
  if (id === OWNER_WORKSPACE_ID) throw new Error("The owner's workspace can't be suspended.");
  await db
    .update(workspaces)
    .set({ status: suspended ? "suspended" : "active" })
    .where(eq(workspaces.id, id));
  refresh();
}
