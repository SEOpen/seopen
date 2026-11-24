import { notFound } from "next/navigation";
import { NoProject } from "@/components/require-project";
import { BackLink } from "@/components/ui/back-link";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { filledColumns, issueFigures, issueSentence } from "@/modules/audit/brief";
import { AuditTabs, SeverityBadge, first, qs } from "@/modules/audit/components/bits";
import { issueDetailRows, resolveCrawl } from "@/modules/audit/queries";
import { CATEGORIES, issueDef } from "@/modules/audit/taxonomy";

export async function generateMetadata({ params }: PageProps<"/audit/issues/[code]">) {
  const def = issueDef((await params).code);
  return { title: def?.title ?? "Issue" };
}

export default async function IssuePage({ params, searchParams }: PageProps<"/audit/issues/[code]">) {
  const { code } = await params;
  const def = issueDef(code);
  if (!def) notFound();
  const project = await getCurrentProject();
  if (!project) return <NoProject />;

  const crawlParam = first((await searchParams).crawl);
  const [{ crawl, previous }, timeZone] = await Promise.all([resolveCrawl(projectScope(project), crawlParam), currentTimeZone()]);
  const rows = crawl ? await issueDetailRows(crawl, previous, code) : [];
  const newCount = rows.filter((r) => r.isNew).length;
  const tableRows = rows.map((r) => ({ ...r, isNewLabel: r.isNew ? "New" : null }));

  return (
    <>
      <BackLink href={`/audit/issues${qs({ crawl: crawlParam })}`}>All issues</BackLink>
      <PageHeader
        title={def.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={def.severity} />
            <span>{CATEGORIES[def.category]}</span>
            {crawl && <span>· crawl of {formatDateTime(crawl.finishedAt, timeZone)}</span>}
          </span>
        }
      />
      <AuditTabs />
      {crawl && (
        <Briefing sentence={issueSentence(rows.length, newCount, previous, crawl, timeZone)}>
          {issueFigures(rows.length, newCount, previous, crawl, timeZone).map((f) => (
            <FigureView key={f.id} data={f} />
          ))}
        </Briefing>
      )}
      <div className="my-6 grid max-w-[68rem] gap-x-8 gap-y-4 text-sm @2xl/main:grid-cols-2">
        <div>
          <h2 className="text-[13px] font-medium">Why it matters</h2>
          <p className="mt-1 text-secondary">{def.why}</p>
        </div>
        <div>
          <h2 className="text-[13px] font-medium">How to fix</h2>
          <p className="mt-1 text-secondary">{def.fix}</p>
        </div>
      </div>
      {!crawl ? (
        <EmptyState title="No finished crawl yet" description="Affected URLs show here after the first crawl finishes." action={<ButtonLink href="/audit#new-crawl">Start a crawl</ButtonLink>} />
      ) : rows.length === 0 ? (
        <EmptyState title="No URLs have this issue" description="This check passed in the selected crawl." />
      ) : (
        <DataTable
          filename={`audit-${code}`}
          columns={filledColumns(
            [
              { key: "url", label: "URL", format: "url" as const },
              { key: "title", label: "Page title" },
              ...(def.detailLabel ? [{ key: "detail", label: def.detailLabel }] : []),
              { key: "statusCode", label: "Status", format: "number" as const, width: 70 },
              { key: "isNewLabel", label: "Change", format: "badge" as const, width: 80 },
            ],
            tableRows,
          )}
          rows={tableRows}
          initialSort={newCount > 0 ? { key: "isNewLabel", desc: true } : undefined}
        />
      )}
    </>
  );
}
