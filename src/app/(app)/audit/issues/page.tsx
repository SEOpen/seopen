import { ArrowRight, Check, ChevronDown } from "lucide-react";
import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { issuesFigures, issuesSentence } from "@/modules/audit/brief";
import { AuditTabs, FilterScroll, SeverityBadge, first, qs } from "@/modules/audit/components/bits";
import { issueSummary, resolveCrawl } from "@/modules/audit/queries";
import { SiteWideNotices } from "@/modules/audit/components/site-wide-notices";
import { splitSiteWide } from "@/modules/audit/site-wide";
import { CATEGORIES, ISSUES, SEVERITIES, SEVERITY_LABEL, type Category, type Severity } from "@/modules/audit/taxonomy";

export const metadata = { title: "Audit issues" };

export default async function IssuesPage({ searchParams }: PageProps<"/audit/issues">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const category = first(sp.category);
  const severity = first(sp.severity);
  const onlyNew = first(sp.new) === "1";
  const all = first(sp.all) === "1";
  const crawlParam = first(sp.crawl);

  const [{ crawl, previous }, timeZone] = await Promise.all([resolveCrawl(projectScope(project), crawlParam), currentTimeZone()]);
  if (!crawl) {
    return (
      <>
        <PageHeader title="Site audit" description={`Issues found on ${project.domain}.`} />
        <AuditTabs />
        <EmptyState title="No finished crawl yet" description="Issues show here after the first crawl finishes." action={<ButtonLink href="/audit#new-crawl">Start a crawl</ButtonLink>} />
      </>
    );
  }
  const { rows, newUrls, fixedUrls } = await issueSummary(crawl, previous);
  const found = new Map(rows.map((r) => [r.code, r]));
  // "All checks" also lists checks that passed, so you can see what was tested.
  const list = (all ? Object.values(ISSUES).map((d) => found.get(d.code) ?? { ...d, count: 0, added: 0, fixed: 0 }) : rows.filter((r) => r.count > 0))
    .filter((r) => !category || r.category === category)
    .filter((r) => !severity || r.severity === severity)
    .filter((r) => !onlyNew || r.added > 0)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.count - a.count);

  // Notices on nearly every page come from the shared template; they fold away under their own heading.
  const shown = splitSiteWide(list, crawl.pagesCrawled);

  const base = { crawl: crawlParam, category, severity, new: onlyNew ? "1" : undefined, all: all ? "1" : undefined };
  const href = (over: Record<string, string | undefined>) => `/audit/issues${qs({ ...base, ...over })}`;
  const sevCount = (s: string) => rows.filter((r) => r.severity === s && (!category || r.category === category)).reduce((n, r) => n + r.count, 0);

  return (
    <>
      <PageHeader title="Site audit" description={`Issues on ${project.domain} · crawl of ${formatDateTime(crawl.finishedAt, timeZone)}`} />
      <AuditTabs />
      <Briefing sentence={issuesSentence(crawl, previous, newUrls, fixedUrls, timeZone)}>
        {issuesFigures({
          failing: rows.filter((r) => r.count > 0).length,
          newUrls,
          fixedUrls,
          crawl,
          previous,
          timeZone,
          links: { failing: `/audit/issues${qs({ crawl: crawlParam })}`, new: `/audit/issues${qs({ crawl: crawlParam, new: "1" })}`, passed: `/audit/issues${qs({ crawl: crawlParam, all: "1" })}` },
        }).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>

      <div className="mt-6 mb-3 flex flex-col items-start gap-2">
        <FilterScroll>
          <SegmentedLinks
            label="Category"
            options={[
              { href: href({ category: undefined }), label: "All categories", active: !category },
              ...(Object.keys(CATEGORIES) as Category[]).map((c) => ({ href: href({ category: c }), label: CATEGORIES[c], active: category === c })),
            ]}
          />
        </FilterScroll>
        <div className="flex max-w-full flex-wrap gap-2">
          <FilterScroll>
            <SegmentedLinks
              label="Severity"
              options={[
                { href: href({ severity: undefined }), label: "All severities", active: !severity },
                ...SEVERITIES.map((s) => ({ href: href({ severity: s }), label: `${SEVERITY_LABEL[s]} ${formatNumber(sevCount(s))}`, active: severity === s })),
              ]}
            />
          </FilterScroll>
          <SegmentedLinks
            label="New issues"
            options={[
              { href: href({ new: undefined }), label: "All issues", active: !onlyNew },
              { href: href({ new: "1" }), label: "New since last crawl", active: onlyNew },
            ]}
          />
          <SegmentedLinks
            label="Passed checks"
            options={[
              { href: href({ all: undefined }), label: "Found", active: !all },
              { href: href({ all: "1" }), label: "Show passed checks", active: all },
            ]}
          />
        </div>
      </div>

      {(shown.rest.length > 0 || !shown.siteWide.length) && (
        <ul className="panel divide-y divide-line-soft overflow-hidden">
          {shown.rest.map((r) => (
            <IssueRow key={r.code} row={r} crawlParam={crawlParam} />
          ))}
          {!list.length && (
            <li className="px-3 py-10 text-center text-sm text-muted">
              No issues match these filters.{" "}
              <Link href={`/audit/issues${qs({ crawl: crawlParam })}`} className="text-accent hover:underline">
                Clear filters
              </Link>
            </li>
          )}
        </ul>
      )}
      {shown.siteWide.length > 0 && (
        <SiteWideNotices count={shown.siteWide.length} className={shown.rest.length ? undefined : "mt-0"}>
          <ul className="panel divide-y divide-line-soft overflow-hidden">
            {shown.siteWide.map((r) => (
              <IssueRow key={r.code} row={r} crawlParam={crawlParam} />
            ))}
          </ul>
        </SiteWideNotices>
      )}
    </>
  );
}

type IssueRowData = { code: string; severity: Severity; count: number; added: number; fixed: number };

function IssueRow({ row: r, crawlParam }: { row: IssueRowData; crawlParam: string | undefined }) {
  const def = ISSUES[r.code];
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-x-3 gap-y-1.5 px-3 @max-2xl/main:flex-wrap py-2.5 text-sm hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent">
          <SeverityBadge severity={r.severity} />
          <span className={cn("min-w-0 flex-1 @max-2xl/main:order-first @max-2xl/main:basis-full", !r.count && "text-muted")}>{def.title}</span>
          <span className="text-xs text-muted @max-2xl/main:hidden">{CATEGORIES[def.category]}</span>
          {r.added > 0 && <span className="data whitespace-nowrap text-bad">+{formatNumber(r.added)} new</span>}
          {r.fixed > 0 && <span className="data whitespace-nowrap text-good">−{formatNumber(r.fixed)} fixed</span>}
          <span className="data ml-auto flex w-14 justify-end">
            {r.count ? (
              formatNumber(r.count)
            ) : (
              <>
                <Check aria-hidden className="size-4 text-secondary" strokeWidth={1.5} />
                <span className="sr-only">Passed</span>
              </>
            )}
          </span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted transition-transform duration-[120ms] ease-instrument group-open:rotate-180" strokeWidth={1.5} />
        </summary>
        <div className="grid gap-3 border-t border-line-soft bg-surface-2/40 px-3 py-3 text-sm @2xl/main:grid-cols-[1fr_1fr_auto]">
          <div>
            <div className="text-xs font-medium text-muted">Why it matters</div>
            <p className="mt-0.5">{def.why}</p>
          </div>
          <div>
            <div className="text-xs font-medium text-muted">How to fix</div>
            <p className="mt-0.5">{def.fix}</p>
          </div>
          {r.count > 0 && (
            <Link href={`/audit/issues/${r.code}${qs({ crawl: crawlParam })}`} className="inline-flex items-center gap-1 self-end text-xs whitespace-nowrap text-accent underline-offset-3 hover:underline">
              View {formatNumber(r.count)} URL{r.count === 1 ? "" : "s"}
              <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
            </Link>
          )}
        </div>
      </details>
    </li>
  );
}
