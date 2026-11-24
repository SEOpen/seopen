import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workspaceMembers, workspaceSettings, workspaces } from "@/db/schema";
import { canonicalTimeZone } from "@/lib/format";
import { OpError, type Actor, type OpOptions } from "@/lib/ops";
import type { WorkspaceScope } from "@/lib/workspace";

/**
 * Workspaces from before this moment keep the zone they read in today, chosen or not. Without it,
 * one that never saved a setting has no row and would look new to the rule below.
 */
export const BROWSER_ZONE_FROM = new Date("2026-11-07T02:45:00Z");

/**
 * Whether a workspace's zone can still come from a browser. Every save on /settings writes a
 * `workspace_settings` row, the default zone included, so no row means nobody has chosen. A row
 * written for something else (a spending cap) counts as chosen too: that errs towards leaving the
 * default in place, and /settings still changes it.
 */
export const takesBrowserZone = (workspace: { createdAt: Date }, settingsRow: unknown) => settingsRow == null && workspace.createdAt >= BROWSER_ZONE_FROM;

export interface AppliedTimeZone {
  dryRun: boolean;
  /** The workspace took this zone. False when it isn't one that takes a browser's. */
  applied: boolean;
  timeZone: string;
  message: string;
}

/**
 * Starts a new workspace on the zone of a member's browser, so its dates read correctly from the
 * first sign-in. Only a real IANA zone and only a member of the workspace; anything else is refused.
 * A workspace that has already chosen, or that predates this, is left as it is and that isn't a
 * refusal. The insert only writes when no row exists, so a save on /settings can't be overwritten,
 * even one that lands at the same moment, and repeating this changes nothing.
 *
 * Only the app calls this: an agent has no browser, and picks a zone no other way.
 */
export async function applyBrowserTimeZoneOp(scope: WorkspaceScope, actor: Actor, zone: string, opts: OpOptions = {}): Promise<AppliedTimeZone> {
  const { workspaceId } = scope;
  const timeZone = canonicalTimeZone(zone);
  if (!timeZone) throw new OpError("That isn't a time zone.");
  const [row] = await db
    .select({ createdAt: workspaces.createdAt, settings: workspaceSettings.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actor.userId)));
  if (!row) throw new OpError("You aren't a member of this workspace.");

  const unchanged = { dryRun: !!opts.dryRun, applied: false, timeZone, message: "This workspace keeps its time zone." };
  if (!takesBrowserZone(row, row.settings)) return unchanged;
  if (opts.dryRun) return { ...unchanged, message: `Would set this workspace's time zone to ${timeZone}.` };
  const written = await db.insert(workspaceSettings).values({ workspaceId, timeZone }).onConflictDoNothing({ target: workspaceSettings.workspaceId }).returning({ workspaceId: workspaceSettings.workspaceId });
  if (!written.length) return unchanged;
  return { dryRun: false, applied: true, timeZone, message: `Set this workspace's time zone to ${timeZone}.` };
}
