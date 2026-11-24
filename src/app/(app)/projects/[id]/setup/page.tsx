import { notFound } from "next/navigation";
import { BackLink } from "@/components/ui/back-link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { isFree } from "@/lib/billing/gates";
import { rules } from "@/plan-policy/rules";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { getProject } from "@/lib/projects";
import { SetupWizard } from "@/modules/setup/components/setup-wizard";
import { setupState } from "@/modules/setup/gather";

export const metadata = { title: "Guided setup" };

/** The guided setup: propose competitors, keywords and prompts, then apply what's kept. A return visit shows what the project tracks now. */
export default async function ProjectSetupPage({ params }: PageProps<"/projects/[id]/setup">) {
  const id = Number((await params).id);
  const project = Number.isInteger(id) ? await getProject(id) : null;
  if (!project) notFound();
  const free = isFree(await loadBillingWorkspace(project.workspaceId));
  const state = free ? null : await setupState(project);
  const site = project.name === project.domain ? project.domain : `${project.name} (${project.domain})`;

  return (
    <>
      {/* An archived project has no Overview to go back to, only its settings. */}
      <BackLink href={project.archived ? `/projects/${project.id}/settings` : `/projects/${project.id}`}>{project.archived ? "Project settings" : `${project.name} overview`}</BackLink>
      <PageHeader title="Guided setup" description={`Suggests what ${site} should track. You pick what to keep.`} />
      {state ? (
        <SetupWizard projectId={project.id} domain={project.domain} state={state} />
      ) : (
        <Callout title="Guided setup comes with a paid plan">
          <p>It suggests competitors, keywords and AI prompts, and the Free plan doesn&apos;t track those. Connect Search Console and run a site audit to get going.</p>
          {rules.plansHref && (
            <div className="mt-2">
              <ButtonLink href={rules.plansHref} size="sm">
                Choose a plan
              </ButtonLink>
            </div>
          )}
        </Callout>
      )}
    </>
  );
}
