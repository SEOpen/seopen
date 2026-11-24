import type { ReactNode } from "react";
import { readFailures } from "@/app/(app)/dashboard-load";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { Callout } from "@/components/ui/callout";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { docsHelpHref } from "@/components/ui/tab-href";
import { Trend } from "@/components/ui/trend";
import { chooseChart } from "@/lib/chart-rule";
import { withoutTone } from "@/lib/check-failure";
import { formatDay } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { ga4DataRange, ga4Series, ga4Totals, landingPagesJoined } from "@/modules/google/data";
import { analyticsFailures } from "@/modules/google/failure";
import { analyticsFigures, analyticsSentence, comparesFairly, earlierLabel, earlierPeriod, landingPageColumns } from "@/modules/google/ga4-brief";
import { AiAssistantsSection } from "@/modules/google/ui/ai-assistants";
import { PropertyMapping } from "@/modules/google/ui/mapping";
import { parsePeriod, PeriodControls, periodsFor } from "@/modules/google/ui/period";
import { ConnectionPanel, getConnection, isUsable, SyncStatus, type Connection } from "@/modules/google/ui/status";
import { alignCompare } from "@/modules/google/windowing";
import { plausibleOpen } from "@/modules/plausible/gate";
import { getPlausibleConnection, PlausibleNotices, PlausiblePanel, PlausibleStop } from "@/modules/plausible/ui/panel";
import { getPosthogConnection, PosthogNotices, PosthogPanel, posthogProjectName } from "@/modules/posthog/ui/panel";
import { umamiOpen } from "@/modules/umami/gate";
import { getUmamiConnection, UmamiNotices, UmamiPanel, umamiSiteName, UmamiStop } from "@/modules/umami/ui/panel";

export const metadata = { title: "Analytics" };

const HELP = docsHelpHref("/ga4");

/** A project reading from GA4 stops updating when Google refuses SEOpen's access, so that's said before the numbers. */
function GoogleNotice({ connection }: { connection: Connection }) {
  if (connection.state !== "reauth") return null;
  return (
    <div className="mb-4">
      <Callout tone="bad" title="Reconnect Google">
        Google stopped accepting SEOpen&apos;s access for {connection.account.email}, so GA4 syncs are paused.{" "}
        <a href="/api/google/connect" className="text-accent hover:underline">
          Reconnect
        </a>
      </Callout>
    </div>
  );
}

/** What sets the page up, after the numbers. */
function Setup({ children }: { children: ReactNode }) {
  return <div className="mt-8 flex flex-col gap-6">{children}</div>;
}

export default async function Ga4Page({ searchParams }: PageProps<"/ga4">) {
  const sp = await searchParams;
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const [connection, posthog, plausible, umami, workspace] = await Promise.all([getConnection(), getPosthogConnection(), getPlausibleConnection(), getUmamiConnection(), currentWorkspace()]);
  const canUsePlausible = plausibleOpen(workspace);
  const canUseUmami = umamiOpen(workspace);
  const onPosthog = !!project.posthogProject;
  const onPlausible = !!project.plausibleSite;
  const onUmami = !!project.umamiSite;
  const posthogNotices = <PosthogNotices project={project} connection={posthog} sp={sp} />;
  const posthogPanel = <PosthogPanel project={project} connection={posthog} />;
  const plausibleNotices = canUsePlausible && <PlausibleNotices project={project} connection={plausible} />;
  // Where the gate is closed, a project still on Plausible or Umami can only stop using it.
  const plausiblePanel = canUsePlausible ? <PlausiblePanel project={project} connection={plausible} /> : onPlausible && <PlausibleStop project={project} />;
  const umamiNotices = canUseUmami && <UmamiNotices project={project} connection={umami} />;
  const umamiPanel = canUseUmami ? <UmamiPanel project={project} connection={umami} /> : onUmami && <UmamiStop project={project} />;
  // The sources this workspace is offered: Plausible and Umami only where they're open.
  const offered = ["GA4", "PostHog", ...(canUsePlausible ? ["Plausible"] : []), ...(canUseUmami ? ["Umami"] : [])];
  const offeredList = offered.length > 2 ? `${offered.slice(0, -1).join(", ")} or ${offered.at(-1)}` : offered.join(" or ");

  // A project's Analytics comes from GA4, PostHog, Plausible or Umami. With none, offer them all, Plausible and Umami only where they're open.
  if (!project.ga4Property && !project.posthogProject && !project.plausibleSite && !project.umamiSite) {
    return (
      <>
        <PageHeader title="Analytics" description={`Organic search sessions from ${offeredList}, matched with Search Console by landing page. Pick one source for this project.`} helpHref={HELP} />
        {posthogNotices}
        {plausibleNotices}
        {umamiNotices}
        <div className="flex flex-col gap-6">
          {isUsable(connection) ? <PropertyMapping currentProjectId={project.id} /> : <ConnectionPanel connection={connection} sp={sp} />}
          {posthogPanel}
          {plausiblePanel}
          {umamiPanel}
        </div>
      </>
    );
  }

  const [posthogName, umamiName] = await Promise.all([onPosthog ? posthogProjectName(project) : null, onUmami ? umamiSiteName(project) : null]);
  const source = onUmami ? (umamiName ? `${umamiName} in Umami` : "Umami") : onPlausible ? `${project.plausibleSite} in Plausible` : onPosthog ? (posthogName ? `${posthogName} in PostHog` : "PostHog") : "Google Analytics";
  const sourceName = onUmami ? "Umami" : onPlausible ? "Plausible" : onPosthog ? "PostHog" : "GA4";
  const notices = (
    <>
      {!onPosthog && !onPlausible && !onUmami && <GoogleNotice connection={connection} />}
      {posthogNotices}
      {plausibleNotices}
      {umamiNotices}
    </>
  );
  const data = await ga4DataRange(projectScope(project));
  if (!data) {
    return (
      <>
        <PageHeader title="Analytics" description={`Organic search sessions from ${source}.`} helpHref={HELP} />
        {notices}
        <EmptyState
          title={`No ${sourceName} data yet`}
          description={`The first sync pulls the last few days, then fills in 16 months of organic landing pages.${onPosthog || onPlausible || onUmami ? ` Sessions from search engines appear once ${sourceName} has some.` : ""}`}
        />
        <Setup>
          <SyncStatus project={project} />
          {onPosthog && posthogPanel}
          {onPlausible && plausiblePanel}
          {onUmami && umamiPanel}
        </Setup>
      </>
    );
  }

  const choice = parsePeriod(sp);
  const periods = periodsFor(choice, data);
  const [cur, prev, series, prevSeries, pages, failures] = await Promise.all([
    ga4Totals(projectScope(project), periods.current),
    periods.previous ? ga4Totals(projectScope(project), periods.previous) : null,
    ga4Series(projectScope(project), periods.current),
    periods.previous ? ga4Series(projectScope(project), periods.previous) : [],
    landingPagesJoined(projectScope(project), periods.current, periods.previous),
    // As on Overview, missing this is better than losing the page.
    currentTimeZone().then((timeZone) => readFailures("ga4", () => analyticsFailures([project], timeZone))),
  ]);
  // The same signal Overview and All projects read. A failed sync or a reconnect says itself in the Sync row and the notices above.
  const stopped = failures.get(project.id)?.kind === "stopped" ? failures.get(project.id)! : null;
  const brief = { source: onUmami ? ("umami" as const) : onPlausible ? ("plausible" as const) : onPosthog ? ("posthog" as const) : ("ga4" as const), periods, compare: choice.compare, first: data.first, current: cur, previous: prev, pages: pages.length };

  const chart = alignCompare(series, prevSeries, periods, ["sessions"], { zero: ["sessions"], first: data.first });
  const points = chart.map((r) => ({ date: r.date, value: r.sessions }));
  const charted = ["line", "columns"].includes(chooseChart(points, { counts: true }).kind);

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`Organic search sessions from ${source}. Latest day with data: ${formatDay(data.last)}.`}
        helpHref={HELP}
        // Only the choices themselves, so a range link doesn't carry anything else along from the URL.
        actions={<PeriodControls path="/ga4" sp={{ days: String(choice.days), compare: choice.compare }} choice={choice} />}
      />
      {notices}
      {stopped && <CheckFailureCallout title={`No ${sourceName} data since ${stopped.since}`} reason={stopped.reason} from={`The numbers below end on ${stopped.since}.`} />}
      <Briefing sentence={analyticsSentence(brief)}>
        {analyticsFigures(brief).map((f) => (
          <FigureView key={f.id} data={f.state === "value" ? { ...f, delta: withoutTone(f.delta, stopped) } : f} />
        ))}
      </Briefing>

      <Section
        title="Landing pages"
        description={`${onPlausible ? "Plausible's visits on its Organic Search channel (any search site it knows, plus links tagged with the medium organic), shown as sessions" : onUmami ? "Umami's visits that arrived from a search site (Google, Bing, DuckDuckGo, Ecosia, Yandex, Baidu, Brave Search or MSN), shown as sessions" : `${sourceName} organic sessions`} per landing page, with Search Console's clicks, impressions, click rate and position for the same URL. Pages with sessions but no Search Console row usually come from Bing, DuckDuckGo or other engines.`}
      >
        <DataTable
          filename={`${project.domain}-landing-pages`}
          initialSort={{ key: "sessions", desc: true }}
          pageSize={25}
          columns={landingPageColumns(pages, { source: brief.source, compare: comparesFairly(periods, data.first) })}
          // A page Search Console has no row for still opens on its own address.
          rows={pages.map((p) => ({ ...p, gscPage: p.gscPage ?? p.url }))}
        />
      </Section>

      <AiAssistantsSection project={project} period={periods.current} organic={cur.sessions} />

      <Section title="Organic sessions" description={periods.previous && charted ? `Lined up day for day with ${earlierPeriod(choice.compare, periods)}.` : undefined}>
        <Trend
          points={points}
          previous={periods.previous ? chart.map((r) => ({ date: r.date, value: r.prev_sessions })) : undefined}
          label="Organic sessions"
          previousLabel={earlierLabel(choice.compare, periods)}
          counts
          noun="day"
        />
      </Section>

      <Setup>
        <SyncStatus project={project} />
        {posthogPanel}
        {plausiblePanel}
        {umamiPanel}
      </Setup>
    </>
  );
}
