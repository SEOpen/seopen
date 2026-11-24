import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { isFree } from "@/lib/billing/gates";
import { currentWorkspace } from "@/lib/workspace/current";
import { noProjectCopy } from "./no-project-copy";

/** Shown by project-scoped pages when no project exists yet, in words that fit the workspace's plan. */
export async function NoProject() {
  const { title, description } = noProjectCopy(isFree(await currentWorkspace()));
  return <EmptyState level={1} title={title} description={description} action={<ButtonLink href="/projects/new">Add a project</ButtonLink>} />;
}
