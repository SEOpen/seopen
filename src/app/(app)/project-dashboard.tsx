import { ArrowRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Fragment, Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { ModuleRow, ModuleRows, ModuleView, type AnyDashboardModule } from "@/components/ui/module-card";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { RetryButton } from "@/components/ui/retry-button";
import { WhatChanged, type ChangeRow } from "@/components/ui/what-changed";
import { isFree } from "@/lib/billing/gates";
import { rules } from "@/plan-policy/rules";
import { loadBillingWorkspace, projectActionRefusal } from "@/lib/billing/workspace";
import { failureLine, failureTone, newerFailed, type CheckFailure } from "@/lib/check-failure";
import { trackedPlaceName } from "@/lib/dataforseo/locations";
import { listCompetitors, type Project } from "@/lib/projects";
import { zonedJobTime } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { ClicksPanel } from "./clicks-panel";
import { buildHeadlines, finishLine, HEADLINE_MODULES, waitingEmpty } from "./dashboard-headlines";
import { loadFailures, loadModules, withFailures } from "./dashboard-load";
import { loadPanel } from "./dashboard-panel";
import { PanelKeywordsTable } from "./panel-keywords";

const PLANS_HREF = rules.plansHref ?? "/";
/** A list of modules, parted into what the plan includes and what it doesn't (`rules.planIncludes`). */
const splitByPlan = <T extends { id: string }>(modules: T[], ws: Parameters<typeof rules.planIncludes>[0]) => ({
  included: modules.filter((m) => rules.planIncludes(ws, m.id)),
  onStarter: modules.filter((m) => !rules.planIncludes(ws, m.id)),
});

const linkFocus = "rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";
const inlineLink = cn("underline-offset-3 hover:underline", linkFocus);

/**
 * One project's Overview, at /projects/[id], and at / when the workspace has only this project: a
 * sentence and its figures, the clicks chart beside What changed, keywords, a section per other module
 * with data, what isn't set up, and when it all last ran.
 */
export async function ProjectDashboard({ project }: { project: Project }) {
  const comps = await listCompetitors(projectScope(project));
  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <>
            {project.name !== project.domain && <>{project.name} · </>}
            <a
              href={`https://${project.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${project.domain} (opens in a new tab)`}
              className={cn("inline-flex min-h-6 items-center gap-1 align-middle text-accent underline-offset-3 hover:underline", linkFocus)}
            >
              {project.domain}
              <ExternalLink aria-hidden className="size-3" strokeWidth={1.5} />
            </a>{" "}
            · {trackedPlaceName(project)} · {comps.length} competitor{comps.length === 1 ? "" : "s"}
          </>
        }
      />
      <Suspense fallback={<PageSkeleton header={false} label="Loading overview" />}>
        <Modules project={project} />
      </Suspense>
    </>
  );
}

/** Runs every module's loader in parallel, then lays out the page. */
async function Modules({ project }: { project: Project }) {
  const timeZone = await currentTimeZone();
  const [loadedResults, failures, panel] = await Promise.all([loadModules(project), loadFailures([project], timeZone), loadPanel(project)]);
  const results = withFailures(loadedResults, failures.get(project.id));

  const loaded: { module: AnyDashboardModule; data: unknown; note?: string }[] = [];
  const looking: { module: AnyDashboardModule; failure: CheckFailure }[] = [];
  const failed: { module: AnyDashboardModule; slow: boolean }[] = [];
  const empty: AnyDashboardModule[] = [];
  const waiting: { module: AnyDashboardModule; text: string }[] = [];
  for (const r of results) {
    if (r.status === "failed") {
      failed.push({ module: r.module, slow: r.slow });
      continue;
    }
    if (r.lastRunFailed) looking.push({ module: r.module, failure: r.lastRunFailed });
    if (r.status === "ok") loaded.push({ module: r.module, data: r.data, note: r.lastRunFailed && newerFailed(r.lastRunFailed) });
    // A source that tried and failed is neither unset nor waiting: the row under the sentence says so.
    else if (r.lastRunFailed) continue;
    else if (r.waiting) waiting.push({ module: r.module, text: r.waiting });
    else empty.push(r.module);
  }

  const nothingYet = loaded.length === 0 && failed.length === 0 && looking.length === 0;
  // With something waiting for its first results, that is the news; the setup line follows it.
  const first = nothingYet && waiting.length === 0 ? empty[0] : undefined;
  // The figures say these modules' states themselves, so the lists below don't repeat them.
  const outsideHeadlines = ({ id }: AnyDashboardModule) => nothingYet || !HEADLINE_MODULES.has(id);
  const waitingRows = waiting.filter(({ module }) => outsideHeadlines(module));
  // Asked always: the closing line mustn't promise Free the daily and weekly checks it doesn't run, nor the notice what's coming,
  // and Free is told what Starter adds rather than offered setup it would refuse.
  const billing = await loadBillingWorkspace(project.workspaceId);
  const free = isFree(billing);
  const { included: notSetUp, onStarter } = splitByPlan((first ? empty.slice(1) : empty).filter(outsideHeadlines), billing);
  const headlines = nothingYet ? null : buildHeadlines(results, { gscConnected: !!project.gscProperty, free });
  // Asked only when the page is about to offer setup, which a locked project would refuse.
  const locked = first ? !!(await projectActionRefusal(projectScope(project))) : false;
  const finish = finishLine(results, timeZone, undefined, free);
  const notice = nothingYet && waiting.length > 0 ? waitingEmpty(project.name, { free, modules: waiting.map(({ module: m }) => m.label), time: zonedJobTime("06:00", timeZone) }) : null;

  return (
    <>
      {notice && (
        <EmptyState
          title={notice.title}
          description={notice.description}
          action={
            free && (
              <div className="flex flex-wrap gap-2">
                <ButtonLink href="/audit" prefetch={false}>
                  Run a site audit
                </ButtonLink>
                <ButtonLink href="/gsc" variant="secondary">
                  Connect Search Console
                </ButtonLink>
              </div>
            )
          }
        />
      )}
      {first && (
        <EmptyState
          title={`Nothing to show for ${project.name} yet`}
          description={
            locked
              ? "Each module adds its numbers here once it has data. This project is read-only, so nothing can be set up until your plan covers it."
              : free
                ? "Each module adds its numbers here once it has data. Start with a site audit, or connect Search Console to see what people search for."
                : "Each module adds its numbers here once it has data. Guided setup suggests competitors, keywords and AI prompts for you to tick, or set up one module yourself."
          }
          action={
            locked ? (
              <Badge>Read-only</Badge>
            ) : (
              <div className="flex flex-wrap gap-2">
                <ButtonLink href={free ? "/audit" : `/projects/${project.id}/setup`} prefetch={false}>
                  {free ? "Run a site audit" : "Start guided setup"}
                </ButtonLink>
                <ButtonLink href={free ? "/gsc" : first.setup.href} variant="secondary">
                  {free ? "Connect Search Console" : `Set up ${first.label}`}
                </ButtonLink>
              </div>
            )
          }
        />
      )}
      {headlines && (
        <>
          <Briefing sentence={headlines.sentence} className="mb-7">
            {headlines.figures.map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>
          {looking.length > 0 && (
            <div className="-mt-3 mb-8">
              <ModuleRows title="Needs a look">
                {looking.map(({ module: m, failure }) => (
                  <ModuleRow
                    key={m.id}
                    label={m.label}
                    text={failureLine(failure)}
                    href={failure.next.href}
                    action={failure.next.label}
                    actionLabel={failure.next.label === "View" || failure.next.label === "Reconnect" ? undefined : failure.next.label}
                    tone={failureTone(failure)}
                  />
                ))}
              </ModuleRows>
            </div>
          )}
          <div className="module-rail">
            {panel.clicks && panel.clicks.days.length > 1 ? <ClicksPanel history={panel.clicks} /> : <NoClicks row={headlines.rows.find((r) => r.key === "clicks")} />}
            {/* The figures already say why a module has no number, so the rail lists only what moved. */}
            <WhatChanged rows={headlines.rows.filter((r) => r.state === "value")} also={headlines.also} />
          </div>
          {panel.keywords && <PanelKeywordsTable data={panel.keywords} className="mt-8" />}
          {loaded.length > 0 && (
            // One column of rows at their own height, a hairline between them, no boxes.
            <div className="mt-8 divide-y divide-line border-t border-line">
              {loaded.map(({ module, data, note }) => (
                <ModuleView key={module.id} module={module} data={data} note={note} />
              ))}
            </div>
          )}
        </>
      )}
      {waitingRows.length > 0 && (
        <ModuleRows title={free ? "Set up, not checked on Free" : "Waiting for first results"}>
          {waitingRows.map(({ module: m, text }) => (
            <ModuleRow key={m.id} label={m.label} text={text} href={m.href} action="View" />
          ))}
        </ModuleRows>
      )}
      {failed.length > 0 && (
        <ModuleRows title="Couldn't load">
          {failed.map(({ module: m, slow }) => (
            <ModuleRow
              key={m.id}
              label={m.label}
              text={slow ? "took too long to load" : "couldn't load its data (the server log has the error)"}
              href={m.href}
              action="View"
              tone="bad"
              extra={<RetryButton />}
            />
          ))}
        </ModuleRows>
      )}
      {notSetUp.length > 0 && <NotSetUp modules={notSetUp} title={first ? "Also available" : "Not set up yet"} setupHref={first || free ? null : `/projects/${project.id}/setup`} />}
      {onStarter.length > 0 && <OnStarter modules={onStarter} />}
      {finish && <p className="mt-8 border-t border-line-soft pt-3 text-xs text-muted">{finish}</p>}
    </>
  );
}

/** What isn't set up, as one line: a name is a link to where it starts. */
function NotSetUp({ modules, title, setupHref }: { modules: AnyDashboardModule[]; title: string; setupHref: string | null }) {
  return (
    <p className="mt-8 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-secondary">
      <span>
        {title}:{" "}
        {modules.map((m, i) => (
          <Fragment key={m.id}>
            {i > 0 && ", "}
            <Link href={m.setup.href} className={cn("text-fg", inlineLink)}>
              {m.label}
            </Link>
          </Fragment>
        ))}
        .
      </span>
      {setupHref && (
        <Link href={setupHref} prefetch={false} className={cn("inline-flex min-h-6 items-center gap-1 text-xs font-medium text-accent", inlineLink)}>
          Guided setup
          <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
        </Link>
      )}
    </p>
  );
}

/** What Starter adds, on Free: named, not linked to setup that Free would refuse, with the way to the plans. */
function OnStarter({ modules }: { modules: AnyDashboardModule[] }) {
  return (
    <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-secondary">
      <span>On Starter: {modules.map((m) => m.label).join(", ")}.</span>
      <Link href={PLANS_HREF} className={cn("inline-flex min-h-6 items-center gap-1 text-xs font-medium text-accent", inlineLink)}>
        See plans
        <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
      </Link>
    </p>
  );
}

/** The chart's place when Search Console has nothing to draw: the row's reason, and where to fix it. */
function NoClicks({ row }: { row?: ChangeRow }) {
  return (
    <section aria-label="Clicks from Google">
      <h2 className="text-[15px] font-medium">Clicks from Google</h2>
      {row?.state === "empty" ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-secondary">
          <span className={cn(row.tone === "bad" && "text-bad")}>{row.text}.</span>
          <Link href={row.href} className={cn("inline-flex min-h-6 items-center gap-1 text-xs font-medium text-accent", inlineLink)}>
            {row.action}
            <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
          </Link>
        </p>
      ) : (
        <p className="mt-2 text-sm text-secondary">The chart starts once a second day has synced.</p>
      )}
    </section>
  );
}
