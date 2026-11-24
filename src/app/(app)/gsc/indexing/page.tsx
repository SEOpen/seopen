import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { formatDateTime, formatDateTimeZoned } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { gscSource, plainState } from "@/modules/google/brief";
import { GscBriefing, gscPropertyContext } from "@/modules/google/ui/context";
import { GscTabs } from "@/modules/google/ui/status";
import { checkIndexingNow } from "@/modules/indexing/actions";
import { indexingFigures, indexingSentence } from "@/modules/indexing/brief";
import { indexingView, linkHints } from "@/modules/indexing/data";
import { RequestedList, RequestQueue } from "@/modules/indexing/ui/request-queue";
import { IndexNowPanel } from "@/modules/indexing/ui/indexnow-panel";

export const metadata = { title: "Indexing · Search Console" };

export default async function IndexingPage({ searchParams }: PageProps<"/gsc/indexing">) {
  const sp = await searchParams;
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const [ctx, view, timeZone] = await Promise.all([gscPropertyContext(sp), indexingView(projectScope(project)), currentTimeZone()]);
  const indexNow = <IndexNowPanel projectId={project.id} domain={project.domain} view={view} timeZone={timeZone} />;

  // IndexNow needs no Google account, so it's offered under the connect panel too.
  if (!ctx.ready) {
    return (
      <>
        {ctx.view}
        {indexNow}
      </>
    );
  }

  const s = view.settings;
  const hints = await linkHints(projectScope(project), view.toRequest.map((p) => p.url));
  const rows = (list: typeof view.notIndexed) =>
    list.map((p) => ({
      ...p,
      coverage: p.coverage ? plainState(p.coverage) : "–",
      lastCrawl: p.lastCrawlTime ? formatDateTime(p.lastCrawlTime, timeZone) : "Never",
      checked: p.inspectedAt ? formatDateTime(p.inspectedAt, timeZone) : "–",
      indexed: p.indexedAt ? formatDateTime(p.indexedAt, timeZone) : "–",
      open: p.inspectionLink,
      openLabel: "Open in Search Console",
    }));

  return (
    <>
      <PageHeader
        title="Search Console"
        description={`${gscSource(ctx.project.gscProperty)} · which sitemap pages Google hasn't indexed, checked with URL Inspection a few hundred a day`}
        actions={
          <ActionForm action={checkIndexingNow.bind(null, project.id)} align="end">
            <Button type="submit" variant="secondary" size="sm">
              Check now
            </Button>
          </ActionForm>
        }
      />
      <GscTabs />
      <GscBriefing sentence={indexingSentence(view)} figures={indexingFigures(view)} />

      <div className="mt-6 flex flex-col gap-3">
        {s?.sitemapError && (
          <Callout tone="warn" title="The sitemap couldn't be read">
            {s.sitemapError} {view.counts.pages ? "The list below is from the last good read." : ""}
          </Callout>
        )}
        {s?.inspectError && <Callout tone="warn" title="Inspections paused">{s.inspectError}</Callout>}
        {s?.sitemapReadAt && (
          <p className="text-xs text-muted [overflow-wrap:anywhere]">
            Sitemap {s.sitemapUrl} read {formatDateTimeZoned(s.sitemapReadAt, timeZone)}
            {s.sitemapPages && s.sitemapPages > view.counts.pages ? `, the first ${view.counts.pages.toLocaleString("en-US")} of ${s.sitemapPages.toLocaleString("en-US")} pages kept` : ""}.
          </p>
        )}
      </div>

      {view.counts.inspected > 0 && (
        <>
          <RequestQueue projectId={project.id} pages={view.toRequest} hints={hints} requestedToday={view.requestedToday} timeZone={timeZone} />
          <RequestedList projectId={project.id} pages={view.requested} timeZone={timeZone} />
        </>
      )}

      {view.others.length > 0 && (
        <Section title="Not indexed for other reasons" description="Request Indexing won't help these until they change. Fix first pages have something stopping Google (noindex, robots.txt, an error, a redirect); duplicates point Google at another page.">
          <DataTable
            filename={`${project.domain}-not-indexed`}
            columns={[
              { key: "url", label: "Page", format: "url" },
              { key: "label", label: "What to do", format: "badge" },
              { key: "coverage", label: "Google says" },
              { key: "lastCrawl", label: "Last crawl", data: true },
              { key: "open", label: "Search Console", format: "url", labelKey: "openLabel" },
            ]}
            rows={rows(view.others)}
          />
        </Section>
      )}

      {view.nowIndexed.length > 0 && (
        <Section title="Now indexed" description="Pages Google indexed in the last 30 days after an earlier check found them missing.">
          <DataTable
            filename={`${project.domain}-now-indexed`}
            columns={[
              { key: "url", label: "Page", format: "url" },
              { key: "indexed", label: "Found indexed", data: true },
            ]}
            rows={rows(view.nowIndexed)}
          />
        </Section>
      )}

      {indexNow}
    </>
  );
}
