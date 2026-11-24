"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { users, workspaceSettings } from "@/db/schema";
import { auth } from "@/lib/auth";
import { canonicalTimeZone, DEFAULT_TIME_ZONE } from "@/lib/format";
import { siteHref } from "@/lib/hosts";
import { OpError } from "@/lib/ops";
import { PROJECT_COOKIE } from "@/lib/projects";
import { recapOpen } from "@/lib/recap/gate";
import { applyBrowserTimeZoneOp } from "@/lib/workspace/browser-time-zone";
import { deleteWorkspaceOp } from "@/lib/workspace/delete";
import { currentWorkspace, workspaceScope } from "@/lib/workspace/current";
import { requireSession } from "@/lib/auth/session";

/** Sets the zone the current workspace's dates and times read in. Refuses anything but a real IANA zone. */
export async function setTimeZone(formData: FormData) {
  await requireSession();
  const timeZone = canonicalTimeZone(z.string().parse(formData.get("timeZone")));
  if (!timeZone) throw new Error("That isn't a time zone.");
  const { workspaceId } = await workspaceScope();
  await db
    .insert(workspaceSettings)
    .values({ workspaceId, timeZone })
    .onConflictDoUpdate({ target: workspaceSettings.workspaceId, set: { timeZone, updatedAt: new Date() } });
  refresh();
}

/**
 * Turns the weekly recap email on or off for the person signed in (src/lib/recap). It's theirs, not
 * the workspace's. Turning it on needs a workspace whose plan has it; turning it off always works.
 */
export async function setWeeklyRecap(enabled: boolean) {
  const user = await requireSession();
  if (enabled && !recapOpen(await currentWorkspace())) throw new Error("The weekly recap isn't available on this workspace's plan.");
  await db.update(users).set({ weeklyRecap: enabled, updatedAt: new Date() }).where(eq(users.id, user.id));
  refresh();
}

/**
 * Turns alert emails on or off for the person signed in (src/modules/alerts). They go to people who
 * get the weekly recap, so this only narrows that: the recap stays as it is either way.
 */
export async function setAlertEmails(enabled: boolean) {
  const user = await requireSession();
  await db.update(users).set({ alertEmails: enabled, updatedAt: new Date() }).where(eq(users.id, user.id));
  refresh();
}

/**
 * Starts a new workspace on the zone the browser reports, for the page to call by itself once. A
 * refusal is nobody's to read, so it's quiet. Refreshes only when the page's dates would change.
 */
export async function applyBrowserTimeZone(zone: string) {
  const user = await requireSession();
  const scope = await workspaceScope();
  try {
    const { applied, timeZone } = await applyBrowserTimeZoneOp(scope, { userId: user.id, source: "app" }, z.string().parse(zone));
    if (applied && timeZone !== DEFAULT_TIME_ZONE) refresh();
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
  }
}

export type DeleteWorkspaceState = { error: string } | null;

/**
 * Permanently deletes the current workspace once "delete" is typed; a refusal comes back as `error`.
 * An account deleted with it is signed out and goes to the marketing site. An admin's account stays,
 * and with no workspace left `currentWorkspace()` sends it on to /admin.
 */
export async function deleteWorkspace(_prev: DeleteWorkspaceState, formData: FormData): Promise<DeleteWorkspaceState> {
  const user = await requireSession();
  const scope = await workspaceScope();
  let accountRemoved: boolean;
  try {
    ({ accountRemoved } = await deleteWorkspaceOp(scope, { userId: user.id, source: "app" }, String(formData.get("confirm") ?? "")));
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  (await cookies()).delete(PROJECT_COOKIE);
  if (!accountRemoved) redirect("/");
  await auth.api.signOut({ headers: await headers() });
  redirect(siteHref("/"));
}
