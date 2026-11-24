import { workspaceScope } from "@/lib/workspace/current";
import { latestHealth } from "@/modules/audit/queries";

/**
 * GET /api/projects/status: each project's site health at its latest crawl, for the project switcher,
 * which asks when it opens so a page load never waits on it. One database read, and nothing spends. The
 * proxy requires a session.
 */
export async function GET() {
  const { workspaceId } = await workspaceScope();
  const rows = await latestHealth(workspaceId);
  const health = Object.fromEntries(rows.flatMap((r) => (r.healthScore == null ? [] : [[r.projectId, Math.round(r.healthScore)]])));
  return Response.json({ health }, { headers: { "Cache-Control": "no-store" } });
}
