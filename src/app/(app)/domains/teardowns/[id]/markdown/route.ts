import { getCurrentUser } from "@/lib/auth/session";
import { locationName } from "@/lib/dataforseo/locations";
import { formatDate } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { teardownMarkdown } from "@/modules/domains/teardown-text";
import { getTeardown } from "@/modules/domains/teardowns";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /domains/teardowns/[id]/markdown: the current project's teardown as a Markdown file. The proxy keeps signed-out visitors away; this checks again. */
export async function GET(_request: Request, { params }: RouteContext<"/domains/teardowns/[id]/markdown">) {
  if (!(await getCurrentUser())) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  const project = await getCurrentProject();
  if (!project) return new Response("No project", { status: 404, headers: NO_STORE });
  const id = Number((await params).id);
  const t = Number.isInteger(id) && id > 0 ? await getTeardown(projectScope(project), id) : null;
  if (!t) return new Response("Not found", { status: 404, headers: NO_STORE });
  const timeZone = await currentTimeZone();
  const slug = t.domain.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "teardown";
  const body = teardownMarkdown(t, { projectName: project.name, market: locationName(t.locationCode), savedOn: formatDate(t.createdAt, timeZone) });
  return new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="teardown-${slug}.md"`, ...NO_STORE },
  });
}
