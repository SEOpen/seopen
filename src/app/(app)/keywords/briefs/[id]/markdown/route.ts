import { getCurrentUser } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { exportMarkdown } from "@/modules/content-briefs/markdown";
import { getBrief } from "@/modules/content-briefs/ops";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /keywords/briefs/[id]/markdown: the current project's brief as a Markdown file. The proxy keeps signed-out visitors away; this checks again. */
export async function GET(_request: Request, { params }: RouteContext<"/keywords/briefs/[id]/markdown">) {
  if (!(await getCurrentUser())) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  const project = await getCurrentProject();
  if (!project) return new Response("No project", { status: 404, headers: NO_STORE });
  const view = await getBrief(projectScope(project), Number((await params).id));
  if (!view) return new Response("Not found", { status: 404, headers: NO_STORE });
  const timeZone = await currentTimeZone();
  const day = (iso: string) => formatDate(iso, timeZone);
  const slug = view.keyword.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "brief";
  return new Response(exportMarkdown(view, day), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="brief-${slug}.md"`, ...NO_STORE },
  });
}
