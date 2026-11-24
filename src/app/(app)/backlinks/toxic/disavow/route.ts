import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { backlinksDomainDecisions } from "@/db/schema";
import { getCurrentProject, getProject } from "@/lib/projects";
import { buildDisavowFile } from "@/modules/backlinks/logic";

/** GET /backlinks/toxic/disavow[?project=ID]: the project's disavow.txt, built locally. Nothing is submitted anywhere. */
export async function GET(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("project"));
  const project = Number.isInteger(id) && id > 0 ? await getProject(id) : await getCurrentProject();
  if (!project) return new Response("No project", { status: 404 });

  const rows = await db
    .select({ domain: backlinksDomainDecisions.domain })
    .from(backlinksDomainDecisions)
    .where(and(eq(backlinksDomainDecisions.workspaceId, project.workspaceId), eq(backlinksDomainDecisions.projectId, project.id), eq(backlinksDomainDecisions.decision, "disavow")));
  const body = buildDisavowFile(
    rows.map((r) => r.domain),
    { target: project.domain, date: new Date() },
  );
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="disavow-${project.domain}.txt"`,
      "Cache-Control": "no-store",
    },
  });
}
