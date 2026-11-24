import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { gscUrlInspections } from "@/db/schema";
import { deleteInBatches } from "@/lib/purge";

/**
 * URL inspections kept per project. Nothing reads more: the Inspect page lists the newest 50, and
 * the fix sync reads the newest INSPECTIONS_KEPT to find pages Google hasn't indexed.
 */
export const INSPECTIONS_KEPT = 200;

/**
 * Deletes each project's URL inspections past its newest INSPECTIONS_KEPT (the daily billing.alerts
 * job). The workspace export holds what's kept. Runs in the worker.
 */
export async function purgeOldInspections(): Promise<number> {
  return deleteInBatches(async (limit) => {
    const ranked = db
      .select({ id: gscUrlInspections.id, n: sql<number>`row_number() over (partition by ${gscUrlInspections.projectId} order by ${gscUrlInspections.inspectedAt} desc, ${gscUrlInspections.id} desc)`.as("n") })
      .from(gscUrlInspections)
      .as("ranked");
    const batch = db.select({ id: ranked.id }).from(ranked).where(sql`${ranked.n} > ${INSPECTIONS_KEPT}`).limit(limit);
    const rows = await db.delete(gscUrlInspections).where(inArray(gscUrlInspections.id, batch)).returning({ id: gscUrlInspections.id });
    return rows.length;
  });
}
