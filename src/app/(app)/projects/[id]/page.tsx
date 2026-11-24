import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { getProject } from "@/lib/projects";
import { ProjectDashboard } from "../../project-dashboard";

export const metadata = { title: "Overview" };

/**
 * One project's Overview. The URL names the project; opening it also makes it the current
 * project (proxy.ts sets the cookie), so the module pages follow.
 *
 * The lookup stays at page level: notFound() thrown inside the page's own Suspense boundary
 * streams the 404 marker but leaves the main area blank instead of showing the not-found page.
 */
export default async function ProjectDashboardPage({ params }: PageProps<"/projects/[id]">) {
  const id = Number((await params).id);
  const project = Number.isInteger(id) ? await getProject(id) : null;
  // Archived projects keep their settings page (to restore them) but have no Overview.
  if (!project || project.archived) notFound();
  return (
    <Suspense fallback={<PageSkeleton label="Loading overview" />}>
      <ProjectDashboard project={project} />
    </Suspense>
  );
}
