import { notFound, redirect } from "next/navigation";
import { getProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { getAlert } from "@/modules/alerts/queries";

/**
 * An alert's link, from its email or the Alerts page: opens the screen it's about. The URL names the
 * project, so proxy.ts makes it the current one first and the screen shows that project's data.
 */
export default async function AlertLink({ params }: PageProps<"/projects/[id]/alerts/[alertId]">) {
  const { id, alertId } = await params;
  const project = Number.isInteger(Number(id)) ? await getProject(Number(id)) : null;
  if (!project || project.archived) notFound();
  const alert = Number.isInteger(Number(alertId)) ? await getAlert(projectScope(project), Number(alertId)) : null;
  if (!alert) notFound();
  redirect(alert.screen);
}
