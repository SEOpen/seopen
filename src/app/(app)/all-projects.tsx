import pLimit from "p-limit";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { lockedProjectIds, limitsFor } from "@/lib/billing/gates";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import type { Project } from "@/lib/projects";
import { currentTimeZone, workspaceScope } from "@/lib/workspace/current";
import { loadFailures, loadModules, withFailures } from "./dashboard-load";
import { ProjectBoard } from "./project-board";
import { boardSentence, summarize, worstClause } from "./project-summary";

/**
 * Projects loading at once. Each runs every module's loader against a pool of five connections, and a
 * loader has five seconds from the moment it starts, so too many together would time each other out.
 */
const AT_ONCE = 2;

/** The home page with two or more projects: one card per project, every project compared on the same six numbers. */
export async function AllProjects({ projects }: { projects: Project[] }) {
  const ws = await loadBillingWorkspace((await workspaceScope()).workspaceId);
  const limit = limitsFor(ws).projects;
  const locked = lockedProjectIds(ws, projects);
  const queue = pLimit(AT_ONCE);
  // First, and once for every project: a few short queries, so they don't queue behind the loaders' five seconds.
  const failures = await loadFailures(projects, await currentTimeZone());
  const loaded = await Promise.all(projects.map((p) => queue(async () => ({ project: p, results: withFailures(await loadModules(p), failures.get(p.id)) }))));
  const board = loaded.map(({ project: p, results }) => ({ id: p.id, name: p.name, domain: p.domain, locked: locked.has(p.id), summary: summarize(results) }));
  const sentence = boardSentence(board.map((b, i) => ({ name: b.name, summary: b.summary, worstClause: worstClause(loaded[i].results) })));
  return (
    <>
      <PageHeader
        title="All projects"
        description={Number.isFinite(limit) ? `${projects.length} of ${limit} projects on your plan` : `${projects.length} projects`}
        actions={
          <ButtonLink href="/projects/new" variant="secondary">
            New project
          </ButtonLink>
        }
      />
      <Briefing sentence={sentence} className="mb-5" />
      <ProjectBoard projects={board} />
    </>
  );
}
