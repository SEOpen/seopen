"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { requireSession } from "@/lib/auth/session";
import { OpError } from "@/lib/ops";
import { requireProject } from "@/lib/projects";
import { queueIndexingSync } from "./jobs";
import { checkKeyFileOp, markRequestedOp, setIndexNowOp } from "./ops";
import { ensureSettings } from "./sync";

/** The Indexing tab's Check now button: reads the sitemap and inspects what's due, in the worker. */
export async function checkIndexingNow(projectId: number): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  // The settings row holds the IndexNow key, so the panel can show it before the worker runs.
  await ensureSettings(scope);
  await queueIndexingSync(scope);
  refresh();
}

/** Check the file: looks for the IndexNow key file on the site. */
export async function checkIndexNowKey(projectId: number): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const r = await checkKeyFileOp(scope);
  refresh();
  if (!r.ok) return { error: r.message };
}

/** The IndexNow switch. Turning it on refuses, saying why, until the key file is on the site. */
export async function setIndexNow(projectId: number, enabled: boolean): Promise<ActionResult> {
  const user = await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    await setIndexNowOp(scope, { userId: user.id, source: "app" }, { enabled });
  } catch (err) {
    if (err instanceof OpError) return { error: err.message };
    throw err;
  }
  refresh();
}

/** Mark requested, and Undo: records that the owner pressed Request Indexing in Search Console. */
export async function markRequested(projectId: number, url: string, requested: boolean): Promise<ActionResult> {
  const user = await requireSession();
  const { scope } = await requireProject(projectId);
  try {
    await markRequestedOp(scope, { userId: user.id, source: "app" }, { urls: [url], requested });
  } catch (err) {
    if (err instanceof OpError) return { error: err.message };
    throw err;
  }
  refresh();
}
