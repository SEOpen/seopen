import { notFound } from "next/navigation";
import { addCompetitorsFromForm, archiveProject, removeCompetitor, saveProjectFromForm } from "@/app/actions/projects";
import { CompetitorForm } from "@/components/competitor-form";
import { DeleteProject } from "@/components/delete-project";
import { ProjectForm } from "@/components/project-form";
import { RestoreProject } from "@/components/restore-project";
import { BackLink } from "@/components/ui/back-link";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { PageHeader } from "@/components/ui/page-header";
import { trackedPlaceName } from "@/lib/dataforseo/locations";
import { getProject, listCompetitors } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { rules } from "@/plan-policy/rules";
import { currentTimeZone } from "@/lib/workspace/current";
import { setIncludeBranded } from "@/modules/ai/actions";
import { analyticsFailures, searchConsoleFailures } from "@/modules/google/failure";
import { propertyName } from "@/modules/google/matching";
import { readFailures } from "../../../dashboard-load";
import { Integration } from "./integration";

export const metadata = { title: "Project settings" };

/** A project's details, competitors and integrations. Its Overview is /projects/[id]. */
export default async function ProjectSettingsPage({ params }: PageProps<"/projects/[id]/settings">) {
  const id = Number((await params).id);
  const project = Number.isInteger(id) ? await getProject(id) : null;
  if (!project) notFound();
  const timeZone = await currentTimeZone();
  const [comps, searchFailure, analyticsFailure] = await Promise.all([
    listCompetitors(projectScope(project)),
    // This page holds Archive and Delete, so a failed read of these can't be what takes it down.
    readFailures("Search Console", () => searchConsoleFailures([project], timeZone)),
    readFailures("Analytics", () => analyticsFailures([project], timeZone)),
  ]);
  const site = project.name === project.domain ? project.domain : `${project.name} · ${project.domain}`;
  const analytics = project.umamiSite ? `Umami website ${project.umamiSite}` : project.plausibleSite ? `Plausible site ${project.plausibleSite}` : project.posthogProject ? `PostHog project ${project.posthogProject}` : project.ga4Property ? propertyName(project.ga4Property) : null;

  return (
    <>
      {/* An archived project has no Overview to go back to, only its place in the archived list. */}
      {project.archived ? <BackLink href="/#archived">Archived projects</BackLink> : <BackLink href={`/projects/${project.id}`}>{project.name} overview</BackLink>}
      <PageHeader title="Project settings" description={`${site}. Rankings are searched from ${trackedPlaceName(project)}.`} />
      {project.archived && (
        <div className="mb-6 max-w-2xl">
          <Callout title="This project is archived">
            Its data is kept and its checks are stopped.
            <div className="mt-3 flex">
              <RestoreProject projectId={id} name={project.name} />
            </div>
          </Callout>
        </div>
      )}
      <div className="module-rail max-w-2xl @5xl/main:max-w-5xl">
        <Card className="self-start">
          <CardHeader title="Details" />
          <CardBody>
            <ProjectForm action={saveProjectFromForm.bind(null, id)} project={project} submitLabel="Save" />
          </CardBody>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader
              title="Guided setup"
              description="Suggests competitors, keywords and AI prompts from the site and Google's data. You review it before anything changes."
            />
            <CardBody>
              <ButtonLink href={`/projects/${id}/setup`} prefetch={false} variant="secondary" size="sm">
                Open guided setup
              </ButtonLink>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Competitors" description="Used for gap analysis, share of voice and AI visibility." />
            <CardBody className="flex flex-col gap-3">
              <ul className="flex flex-col divide-y divide-line text-sm">
                {comps.map((d) => (
                  <li key={d} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{d}</span>
                    <form action={removeCompetitor.bind(null, id, d)} className="shrink-0">
                      <Button variant="ghost" size="sm" type="submit" aria-label={`Remove ${d}`}>
                        Remove
                      </Button>
                    </form>
                  </li>
                ))}
                {!comps.length && <li className="py-1.5 text-muted">None yet</li>}
              </ul>
              <CompetitorForm action={addCompetitorsFromForm.bind(null, id)} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="AI visibility"
              description="A branded prompt names your brand, so its answers name you almost by definition. Left out by default."
            />
            <CardBody className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>
                Branded prompts are <b>{project.aiIncludeBranded ? "counted" : "left out"}</b>
              </span>
              <form action={setIncludeBranded.bind(null, id, !project.aiIncludeBranded)}>
                <Button variant="secondary" size="sm" type="submit">
                  {project.aiIncludeBranded ? "Leave out" : "Count them"}
                </Button>
              </form>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Integrations" />
            <CardBody>
              <dl className="grid gap-2 text-sm">
                <Integration name="Search Console" connected={project.gscProperty ? propertyName(project.gscProperty) : null} connectHref={project.archived ? null : "/gsc"} reconnect={searchFailure.get(id)?.kind === "reconnect"} />
                <Integration name="Analytics" connected={analytics} connectHref={project.archived ? null : "/ga4"} reconnect={analyticsFailure.get(id)?.kind === "reconnect"} />
              </dl>
            </CardBody>
          </Card>
          {project.archived ? (
            <Card id="delete" className="scroll-mt-20">
              <CardHeader
                title={`Delete ${project.name}`}
                description="Permanently deletes this project and all its keywords, rankings, audits, AI answers and Local SEO data. This can't be undone. Your spend history stays."
              />
              <CardBody>
                <DeleteProject projectId={id} />
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardHeader title="Archive project" description={`Stops this project's checks and keeps its data. You can restore it later${rules.hasPlans ? ", if your plan has room for it" : ""}.`} />
              <CardBody>
                <form action={archiveProject.bind(null, id)}>
                  {/* It can be restored, so it asks without being a danger button. */}
                  <ConfirmSubmit size="md" question={`Archive ${project.name}?`} confirmLabel="Archive">
                    Archive project
                  </ConfirmSubmit>
                </form>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
