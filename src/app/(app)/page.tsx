import { Suspense } from "react";
import { NoProject } from "@/components/require-project";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { listProjects } from "@/lib/projects";
import { AllProjects } from "./all-projects";
import { ArchivedProjects } from "./archived-projects";
import { homeTitle } from "./home-title";
import { ProjectDashboard } from "./project-dashboard";

/** Named for what Home shows: getting started, the one project's Overview, or All projects. The page streams, so this can wait for the list. */
export async function generateMetadata() {
  return { title: homeTitle((await listProjects()).length) };
}

/**
 * The app's home. No projects: the first-project empty state. One: that project's Overview (the same
 * one /projects/[id] serves). Two or more: All projects, a card per project. Archived projects, if any,
 * are listed at the bottom with Restore. The page itself doesn't wait for anything, so a skeleton shows at once.
 */
export default function HomePage() {
  return (
    <Suspense fallback={<PageSkeleton label="Loading projects" />}>
      <Home />
    </Suspense>
  );
}

async function Home() {
  const projects = await listProjects();
  const main = !projects.length ? <NoProject /> : projects.length === 1 ? <ProjectDashboard project={projects[0]} /> : <AllProjects projects={projects} />;
  return (
    <>
      {main}
      <Suspense fallback={null}>
        <ArchivedProjects />
      </Suspense>
    </>
  );
}
