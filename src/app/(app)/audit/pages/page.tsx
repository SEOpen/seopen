import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { filledColumns, pageStats, pagesFigures, pagesSentence } from "@/modules/audit/brief";
import { AuditTabs, FilterScroll, first, qs } from "@/modules/audit/components/bits";
import { crawlPages, issueRows, resolveCrawl } from "@/modules/audit/queries";
import { STATUS_CLASSES, statusClass } from "@/modules/audit/status";

export const metadata = { title: "Crawled pages" };

export default async function CrawledPages({ searchParams }: PageProps<"/audit/pages">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const status = first(sp.status);
  const crawlParam = first(sp.crawl);
  const [{ crawl }, timeZone] = await Promise.all([resolveCrawl(projectScope(project), crawlParam), currentTimeZone()]);

  if (!crawl) {
    return (
      <>
        <PageHeader title="Site audit" description={`Pages crawled on ${project.domain}.`} />
        <AuditTabs />
        <EmptyState title="No finished crawl yet" description="Pages show here after the first crawl finishes." action={<ButtonLink href="/audit#new-crawl">Start a crawl</ButtonLink>} />
      </>
    );
  }
  const [all, issues] = await Promise.all([crawlPages(crawl), issueRows(crawl)]);
  const cls = STATUS_CLASSES.find((c) => c.key === status);
  const rows = (cls ? all.filter((p) => statusClass(p.statusCode) === cls.key) : all).map((p) => ({
    url: p.url,
    statusCode: p.statusCode,
    title: p.title,
    issueCount: p.issueCount,
    depth: p.depth,
    wordCount: p.wordCount,
    internalLinksIn: p.internalLinksIn,
    internalLinksOut: p.internalLinksOut,
    loadTimeMs: p.loadTimeMs,
    indexableLabel: p.indexable == null ? null : p.indexable ? "Yes" : "No",
  }));
  const stats = pageStats(all, issues);

  return (
    <>
      <PageHeader title="Site audit" description={`${formatNumber(all.length)} URLs on ${project.domain} · crawl of ${formatDateTime(crawl.finishedAt, timeZone)}`} />
      <AuditTabs />
      <Briefing sentence={pagesSentence(stats, crawl, timeZone)}>
        {pagesFigures(stats, crawl, timeZone, { redirects: `/audit/pages${qs({ crawl: crawlParam, status: "3xx" })}` }).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      <div className="mt-6 mb-3">
        <FilterScroll>
          <SegmentedLinks
            label="Status"
            options={[
              { href: `/audit/pages${qs({ crawl: crawlParam })}`, label: `All ${formatNumber(all.length)}`, active: !cls },
              ...STATUS_CLASSES.flatMap((c) => {
                const n = all.filter((p) => statusClass(p.statusCode) === c.key).length;
                return n ? [{ href: `/audit/pages${qs({ crawl: crawlParam, status: c.key })}`, label: `${c.label} ${formatNumber(n)}`, active: cls?.key === c.key }] : [];
              }),
            ]}
          />
        </FilterScroll>
      </div>
      <DataTable
        filename="audit-pages"
        pageSize={100}
        initialSort={{ key: "issueCount", desc: true }}
        columns={filledColumns(
          [
            { key: "url", label: "URL", format: "url" as const },
            { key: "statusCode", label: "Status", format: "number" as const, width: 64 },
            { key: "title", label: "Title" },
            { key: "issueCount", label: "Issues", format: "number" as const },
            { key: "depth", label: "Depth", format: "number" as const },
            { key: "wordCount", label: "Words", format: "number" as const },
            { key: "internalLinksIn", label: "Links in", format: "number" as const },
            { key: "internalLinksOut", label: "Links out", format: "number" as const },
            { key: "loadTimeMs", label: "Load (ms)", format: "number" as const },
            { key: "indexableLabel", label: "Indexable", format: "badge" as const },
          ],
          rows,
        )}
        rows={rows}
      />
    </>
  );
}
