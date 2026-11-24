// What Search Console says about tracked keywords. Its averages cover every location and device, so
// they're a reason to look again or a note beside a miss, and never a position.
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { gscQueries } from "@/db/schema/google";
import type { ProjectScope } from "@/lib/workspace";
import { daysBefore, RECENT_DAYS } from "./recheck";

/** Each keyword's average position from `since` (the recent window by default) to `date`, by impressions, keyed by lowercase keyword. Keywords with no data are left out. */
export async function searchConsoleAverages(scope: ProjectScope, keywords: string[], date: string, since = daysBefore(date, RECENT_DAYS)): Promise<Map<string, number>> {
  const queries = [...new Set(keywords.map((k) => k.toLowerCase()))];
  if (!queries.length) return new Map();
  const rows = await db
    .select({
      query: gscQueries.query,
      position: sql<number | null>`sum(${gscQueries.position} * ${gscQueries.impressions}) / nullif(sum(${gscQueries.impressions}), 0)`,
    })
    .from(gscQueries)
    .where(
      and(
        eq(gscQueries.workspaceId, scope.workspaceId),
        eq(gscQueries.projectId, scope.projectId),
        inArray(gscQueries.query, queries),
        gte(gscQueries.date, since),
        lte(gscQueries.date, date),
      ),
    )
    .groupBy(gscQueries.query);
  return new Map(rows.flatMap((r) => (r.position == null ? [] : [[r.query, Number(r.position)] as const])));
}
