import { RestoreProject } from "@/components/restore-project";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { listArchivedProjects } from "@/lib/projects";
import { rules } from "@/plan-policy/rules";

/** At the bottom of the projects list (the home page): archived projects, each with Restore. Nothing when there are none. */
export async function ArchivedProjects() {
  const archived = await listArchivedProjects();
  if (!archived.length) return null;
  return (
    <Card id="archived" className="mt-8 scroll-mt-20">
      <CardHeader
        title="Archived projects"
        description={`Archiving keeps a project's data and stops its checks. Restoring brings it back as it was${rules.hasPlans ? ", if your plan has room for it, its keywords and its AI prompts" : ""}.`}
      />
      <ul className="divide-y divide-line text-sm">
        {archived.map((p) => (
          <li key={p.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
            <span>
              <span className="font-medium [overflow-wrap:anywhere]">{p.name}</span>
              <span className="block text-xs text-muted [overflow-wrap:anywhere]">{p.domain}</span>
            </span>
            <span className="flex items-start gap-2">
              {/* prefetch off: opening /projects/<id> switches the project cookie, and an archived id would drop the person on their first project. */}
              <ButtonLink href={`/projects/${p.id}/settings#delete`} prefetch={false} variant="danger" size="sm" aria-label={`Delete ${p.name}`}>
                Delete
              </ButtonLink>
              <RestoreProject projectId={p.id} name={p.name} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
