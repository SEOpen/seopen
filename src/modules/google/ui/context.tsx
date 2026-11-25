import type { ReactNode } from "react";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView, type FigureData } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProject, type Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { gscSource } from "../brief";
import { gscDataRange } from "../data";
import type { Periods } from "../windowing";
import { PropertyMapping } from "./mapping";
import { parsePeriod, periodsFor, type PeriodChoice } from "./period";
import { ConnectionPanel, getConnection, GscTabs, isUsable, SyncStatus, type Connection } from "./status";

export type SP = Record<string, string | string[] | undefined>;

export type GscContext =
  | { ready: false; view: ReactNode }
  | { ready: true; project: Project & { gscProperty: string }; connection: Connection; choice: PeriodChoice; periods: Periods; data: { first: string; last: string } };

/**
 * Resolves the current project, connection, mapping and stored date range for a Search Console
 * page. When something is missing, `view` is the page to show instead (connect, map, wait for sync).
 */
export async function gscContext(sp: SP, title = "Search Console"): Promise<GscContext> {
  const base = await gscPropertyContext(sp, title);
  if (!base.ready) return base;
  const { project, connection, header } = base;
  const data = await gscDataRange(projectScope(project));
  if (!data) {
    return {
      ready: false,
      view: (
        <>
          {header}
          <GscTabs />
          <div className="flex flex-col gap-6">
            <EmptyState title="No Search Console data yet" description="The first sync pulls the last few days, then backfills history in the background." />
            <SyncStatus project={project} />
          </div>
        </>
      ),
    };
  }
  const choice = parsePeriod(sp);
  return { ready: true, project, connection, choice, periods: periodsFor(choice, data), data };
}

/** Like gscContext, for pages that need a connected, mapped project but no synced data. */
export async function gscPropertyContext(
  sp: SP,
  title = "Search Console",
): Promise<{ ready: false; view: ReactNode } | { ready: true; project: Project & { gscProperty: string }; connection: Connection; header: ReactNode }> {
  const project = await getCurrentProject();
  if (!project) return { ready: false, view: <NoProject /> };
  const connection = await getConnection();
  const header = <PageHeader title={title} description={gscSource(project.gscProperty ?? project.domain)} />;

  if (!isUsable(connection)) {
    return {
      ready: false,
      view: (
        <>
          {header}
          <div className="flex flex-col gap-6">
            <ConnectionPanel connection={connection} sp={sp} />
            {project.gscProperty && <SyncStatus project={project} />}
          </div>
        </>
      ),
    };
  }
  if (!project.gscProperty) {
    return {
      ready: false,
      view: (
        <>
          {header}
          <div className="flex flex-col gap-6">
            <ConnectionPanel connection={connection} sp={sp} />
            <PropertyMapping currentProjectId={project.id} />
          </div>
        </>
      ),
    };
  }
  return { ready: true, project: { ...project, gscProperty: project.gscProperty }, connection, header };
}

/** The sentence and its figures. A page with nothing to count yet has the sentence alone. */
export function GscBriefing({ sentence, figures }: { sentence: string; figures: FigureData[] }) {
  return (
    <Briefing sentence={sentence}>
      {figures.length > 0
        ? figures.map((f) => (
            <FigureView key={f.id} data={f} />
          ))
        : null}
    </Briefing>
  );
}
