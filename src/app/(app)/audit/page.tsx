import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { Button, buttonVariants } from "@/components/ui/button";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Figure, FigureStrip, FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { checkGate } from "@/lib/billing/check-gate";
import { isInternal, limitsFor, showsDollarCosts } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { failureAgain, failureLink, pageFailure, withoutRetryAdvice } from "@/lib/check-failure";
import { CRAWL_CANCELLED, plainCrawlFailure, plainLighthouseFailure } from "@/lib/dataforseo/failure-copy";
import { formatDateTimeZoned, formatNumber, formatShortDate, formatUsd } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { mondayJobTime } from "@/lib/schedule";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { ActionForm } from "@/components/ui/action-form";
import { setWeekly, startLighthouse } from "@/modules/audit/actions";
import { auditFigures, auditSentence, crawlExtent, crawlPoints, earlierCrawl, filledColumns, repeatedDays, wholeScore } from "@/modules/audit/brief";
import { readAccessReport } from "@/modules/audit/access";
import { AccessPanel } from "@/modules/audit/components/access-panel";
import { AutoRefresh } from "@/modules/audit/components/auto-refresh";
import { AuditTabs, FixesNext, SeverityBadge, StatusBar, qs } from "@/modules/audit/components/bits";
import { CrawlForm } from "@/modules/audit/components/crawl-form";
import { CrawlProgress } from "@/modules/audit/components/crawl-progress";
import { CrawlTrend } from "@/modules/audit/components/crawl-trend";
import { SiteWideNotices } from "@/modules/audit/components/site-wide-notices";
import { LighthouseButton } from "@/modules/audit/components/lighthouse-button";
import { activeCrawl, getSettings } from "@/modules/audit/crawl";
import { auditFailure } from "@/modules/audit/failure";
import { issueSummary, latestLighthouse, listCrawls, resolveCrawl, statusBreakdown, type IssueSummary } from "@/modules/audit/queries";
import { splitSiteWide } from "@/modules/audit/site-wide";
import { CATEGORIES, SEVERITIES, SEVERITY_LABEL, type Category } from "@/modules/audit/taxonomy";
import { estimateCrawlCost } from "@/modules/audit/transform";
import { fixCounts } from "@/modules/fixes/queries";

export const metadata = { title: "Site audit" };

const CRAWL_PHASE: Record<string, string> = {
  queued: "queued",
  posting: "starting",
  crawling: "running",
  importing: "being imported",
};

const STATUS_WORD: Record<string, string> = {
  queued: "Queued",
  posting: "Starting",
  crawling: "Running",
  importing: "Saving results",
  done: "Finished",
  failed: "Failed",
};

const TRIGGER_WORD: Record<string, string> = { manual: "Started by hand", schedule: "Weekly re-crawl" };

export default async function AuditPage() {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;

  const [ws, gate, spend, timeZone, settings, running, { crawl, previous, all }, history, lighthouse] = await Promise.all([
    currentWorkspace(),
    checkGate(project.workspaceId),
    spendState(project.workspaceId),
    currentTimeZone(),
    getSettings(projectScope(project)),
    activeCrawl(projectScope(project)),
    resolveCrawl(projectScope(project)),
    listCrawls(projectScope(project), 30),
    latestLighthouse(projectScope(project)),
  ]);
  const access = crawl ? readAccessReport(crawl.summary) : null;
  const [summary, status, fixes] = crawl ? await Promise.all([issueSummary(crawl, previous), statusBreakdown(crawl), fixCounts(projectScope(project))]) : [null, null, null];
  // Notices on nearly every page come from the shared template; they fold away so a new issue isn't buried under them.
  const issues = splitSiteWide(summary?.rows ?? [], crawl?.pagesCrawled);
  // The same reading as Overview, so a crawl someone cancelled isn't a failure here either.
  const failure = pageFailure(auditFailure(history[0], project.id, timeZone), gate("audit", project.id));
  const lastFailed = failure ? history[0] : null;
  const crawlFailure = lastFailed && plainCrawlFailure(lastFailed.error);
  // Customers' audits are covered by the plan: they see the page limit, not DataForSEO prices.
  const showCost = showsDollarCosts(ws);
  // The stored error is for the people who run SEOpen; everyone else gets the plain wording.
  const rawErrors = isInternal(ws);
  const planPages = limitsFor(ws).auditPages;
  // A refusal the banner doesn't give (this week's Free audit used, a read-only project) shows on the form before a click, not after.
  const startRefusal = spend.refusal ? null : gate("audit", project.id);
  const recrawl = mondayJobTime("05:30", timeZone);
  // The weekly crawl runs with these settings, about 4.33 times a month.
  const weeklyCost = showCost ? formatUsd(estimateCrawlCost(settings) * 4.33) : null;
  // Only what the columns need goes to the browser, so a customer's page never carries a dollar figure.
  const historyRows = history.map((c) => ({
    createdAt: c.createdAt.toISOString(),
    status: c.error === CRAWL_CANCELLED ? "Cancelled" : (STATUS_WORD[c.status] ?? c.status),
    trigger: TRIGGER_WORD[c.trigger] ?? c.trigger,
    pagesCrawled: c.pagesCrawled,
    healthScore: c.healthScore,
    errors: c.errors,
    warnings: c.warnings,
    ...(showCost ? { costUsd: c.costUsd } : {}),
  }));
  // Two crawls started on one day can only be told apart by their times.
  const startedFormat = repeatedDays(history.map((c) => c.createdAt), timeZone).size ? ("datetime" as const) : ("date" as const);

  return (
    <>
      <PageHeader
        title="Site audit"
        description={
          crawl ? (
            <>
              {project.domain} · finished {formatDateTimeZoned(crawl.finishedAt, timeZone)} · {crawlExtent(crawl)}, {crawl.enableJavascript ? "with JavaScript running" : "without running JavaScript"}
            </>
          ) : (
            `SEOpen crawls ${project.domain} and lists the technical SEO issues it finds.`
          )
        }
        actions={
          crawl && (
            // A plain anchor: Next's Link ignores a click to the hash already in the URL, so a second click wouldn't scroll.
            <a href="#new-crawl" className={buttonVariants({ variant: "secondary" })}>
              New crawl
            </a>
          )
        }
      />
      <AuditTabs />

      {running && <CrawlProgress crawl={running} showCost={showCost} timeZone={timeZone} />}
      {lastFailed && failure && crawlFailure && !running && (
        <CheckFailureCallout
          title={`Last crawl failed (${formatDateTimeZoned(lastFailed.createdAt, timeZone)})`}
          reason={rawErrors && lastFailed.error ? lastFailed.error : failure.blocked ? withoutRetryAdvice(crawlFailure.message) : crawlFailure.message}
          from={crawl && `Results below are from ${formatShortDate(crawl.finishedAt, timeZone)}.`}
          again={failureAgain(failure, null)}
          link={failure.retry ? { label: "Start a new crawl", href: "#new-crawl" } : failureLink(failure)}
        />
      )}

      {crawl ? (
        <Briefing sentence={auditSentence({ crawl, previous, newUrls: summary?.newUrls, fixedUrls: summary?.fixedUrls }, timeZone)}>
          {auditFigures(crawl, previous, timeZone).map((f) => (
            <FigureView key={f.id} data={f} />
          ))}
        </Briefing>
      ) : (
        <Briefing sentence={auditSentence({ crawl: null, running: !!running, failed: !!lastFailed }, timeZone)} />
      )}

      {crawl && summary && status && (
        <>
          <div className="module-rail">
            <div>
              <Section
                title="Top issues"
                actions={
                  <Link href="/audit/issues" className="text-xs text-accent hover:underline">
                    All issues
                  </Link>
                }
              >
                <TopIssues rows={issues.rest.filter((r) => r.count > 0).slice(0, 8)} />
                {!!fixes?.open && <FixesNext />}
              </Section>
              {issues.siteWide.length > 0 && (
                <SiteWideNotices count={issues.siteWide.length}>
                  <TopIssues rows={issues.siteWide} />
                </SiteWideNotices>
              )}
              <Section title="Issues by category" description="Issues per category and severity, one for each URL a check flags. Select a number to filter.">
                <CategoryMatrix rows={summary.rows} />
              </Section>
            </div>
            <div>
              <Section
                title="Since the last crawl"
                description={previous ? `Compared with ${earlierCrawl(previous, crawl, timeZone)}` : undefined}
                actions={
                  previous && (
                    <Link className="text-xs text-accent hover:underline" href={`/audit/compare${qs({ a: previous.id, b: crawl.id })}`}>
                      Compare crawls
                    </Link>
                  )
                }
              >
                <SinceLast hasPrevious={!!previous} newUrls={summary.newUrls} fixedUrls={summary.fixedUrls} rows={summary.rows} />
              </Section>
              <Section title="Crawled URLs" description={`${formatNumber(crawl.pagesCrawled)} pages`}>
                <StatusBar counts={status} />
              </Section>
            </div>
          </div>

          {access && (
            <Section title="Crawler and AI access" description="What robots.txt and the server let search and AI crawlers do, checked when this crawl finished.">
              <AccessPanel report={access} timeZone={timeZone} />
            </Section>
          )}

          <Section title="Health and issues over time" description={`${all.length} finished crawl${all.length === 1 ? "" : "s"}`}>
            {all.length < 2 ? (
              <CrawlTrend title="Health score" points={crawlPoints(all, wholeScore, timeZone)} format="score" />
            ) : (
              <div className="grid gap-6 @3xl/main:grid-cols-3">
                <CrawlTrend title="Health score" points={crawlPoints(all, wholeScore, timeZone)} format="score" />
                <CrawlTrend title="Errors" points={crawlPoints(all, (c) => c.errors, timeZone)} />
                <CrawlTrend title="Warnings" points={crawlPoints(all, (c) => c.warnings, timeZone)} />
              </div>
            )}
          </Section>
        </>
      )}

      {history.length > 0 && (
        <Section title="Crawl history">
          <DataTable
            filename="audit-crawls"
            searchable={false}
            pageSize={10}
            columns={filledColumns(
              [
                { key: "createdAt", label: "Started", format: startedFormat },
                { key: "status", label: "Status", format: "badge" as const },
                { key: "trigger", label: "How it started" },
                { key: "pagesCrawled", label: "Pages", format: "number" as const },
                { key: "healthScore", label: "Health", format: "number" as const },
                { key: "errors", label: "Errors", format: "number" as const },
                { key: "warnings", label: "Warnings", format: "number" as const },
                ...(showCost ? [{ key: "costUsd", label: "Cost", format: "usd" as const }] : []),
              ],
              historyRows,
            )}
            rows={historyRows}
          />
        </Section>
      )}

      <div id="new-crawl" className="module-rail mt-8 scroll-mt-6 items-start">
        <Card>
          <CardHeader title="New crawl" description={limitsFor(ws).javascript ? "JavaScript rendering is off by default; turn it on only for sites that build their content in the browser." : "The Free plan crawls once a week, without rendering JavaScript."} />
          <CardBody>
            <CrawlForm
              defaultMaxPages={settings.maxPages}
              defaultJs={settings.enableJavascript}
              showCost={showCost}
              planPages={Number.isFinite(planPages) ? planPages : null}
              allowJavascript={limitsFor(ws).javascript}
              // Before any results this is what the page is for, so it runs on one click, as it did for the first crawl,
              // whatever the last one failed with. Once there are numbers to look at it asks first.
              first={!crawl}
              refused={!!spend.refusal}
              disabledReason={
                running
                  ? `A crawl is ${CRAWL_PHASE[running.status] ?? "in progress"}. You can start a new one when it finishes${running.status === "importing" ? "" : ", or stop it above"}.`
                  : startRefusal && !startRefusal.upgradable
                    ? startRefusal.message
                    : null
              }
            />
          </CardBody>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader title="Weekly re-crawl" description={`${recrawl.days} at ${recrawl.zoned} with the settings of your last crawl.`} />
            <CardBody>
              <ActionForm action={setWeekly.bind(null, !settings.weeklyEnabled)} className="flex flex-wrap items-center justify-between gap-3">
                <Badge tone={settings.weeklyEnabled ? "good" : "neutral"}>{settings.weeklyEnabled ? "On" : "Off"}</Badge>
                {settings.weeklyEnabled ? (
                  <Button size="sm" variant="secondary" type="submit">
                    Turn off
                  </Button>
                ) : (
                  <SpendConfirm confirmLabel="Turn on" question={`Re-crawl ${recrawl.days} at ${recrawl.zoned}${weeklyCost ? `, about ${weeklyCost} a month` : ""}?`}>
                    {weeklyCost ? `Turn on (≈ ${weeklyCost}/mo)` : "Turn on"}
                  </SpendConfirm>
                )}
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Homepage Lighthouse" description={lighthouse ? `Desktop · ${formatDateTimeZoned(lighthouse.createdAt, timeZone)}` : "Desktop test scores for the homepage"} />
            <CardBody className="flex flex-col gap-3 text-sm">
              {lighthouse?.status === "done" && (
                <FigureStrip label="Lighthouse scores">
                  <LighthouseScore label="Performance" value={lighthouse.performance} />
                  <LighthouseScore label="Accessibility" value={lighthouse.accessibility} />
                  <LighthouseScore label="Best practices" value={lighthouse.bestPractices} />
                  <LighthouseScore label="SEO" value={lighthouse.seo} />
                </FigureStrip>
              )}
              {lighthouse?.status === "done" && lighthouse.metrics && (
                <dl className="flex flex-col gap-1 text-xs text-muted">
                  <Timing label="Main content shows" value={fmtMs(lighthouse.metrics.lcp)} />
                  <Timing label="First content shows" value={fmtMs(lighthouse.metrics.fcp)} />
                  <Timing label="Page blocked for" value={fmtMs(lighthouse.metrics.tbt)} />
                  <Timing label="Layout shift" value={lighthouse.metrics.cls?.toFixed(3) ?? "–"} />
                </dl>
              )}
              {lighthouse?.status === "queued" && (
                <>
                  <AutoRefresh seconds={8} />
                  <p className="text-muted">Running Lighthouse (up to 2 minutes)…</p>
                </>
              )}
              {lighthouse?.status === "failed" && <p className="text-bad">{rawErrors && lighthouse.error ? lighthouse.error : plainLighthouseFailure(lighthouse.error)}</p>}
              <ActionForm action={startLighthouse}>
                <LighthouseButton queued={lighthouse?.status === "queued"} showCost={showCost} refused={spend.refusal?.message} />
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function fmtMs(v: number | null | undefined) {
  if (v == null) return "–";
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

function LighthouseScore({ label, value }: { label: string; value: number | null }) {
  const band = value == null ? null : value >= 90 ? (["good", "Good"] as const) : value >= 50 ? (["warn", "Needs work"] as const) : (["bad", "Poor"] as const);
  return <Figure small label={label} value={value ?? "–"} caption={band && <Badge tone={band[0]}>{band[1]}</Badge>} />;
}

function Timing({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt>{label}</dt>
      <dd className="data text-fg">{value}</dd>
    </div>
  );
}

function TopIssues({ rows }: { rows: IssueSummary[] }) {
  if (!rows.length) return <p className="text-sm text-muted">No issues found in this crawl.</p>;
  const anyNew = rows.some((r) => r.added > 0);
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="table-head">
          <tr>
            <th className="h-9 px-3 text-left font-medium">Severity</th>
            <th className="h-9 px-3 text-left font-medium">Issue</th>
            <th className="h-9 px-3 text-left font-medium @max-2xl/main:hidden">Category</th>
            {anyNew && <th className="h-9 px-3 text-right font-medium">New</th>}
            <th className="h-9 px-3 text-right font-medium">URLs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-t border-line-soft hover:bg-surface-2/60">
              <td className="px-3 py-2.5">
                <SeverityBadge severity={r.severity} />
              </td>
              <td className="min-w-40 px-3 py-2.5">
                <Link href={`/audit/issues/${r.code}`} className="underline-offset-4 hover:underline">
                  {r.title}
                </Link>
              </td>
              <td className="px-3 py-2.5 text-muted @max-2xl/main:hidden">{CATEGORIES[r.category as Category]}</td>
              {anyNew && <td className="data px-3 py-2.5 text-right text-bad">{r.added > 0 ? `+${formatNumber(r.added)}` : <span className="text-muted">–</span>}</td>}
              <td className="data px-3 py-2.5 text-right">{formatNumber(r.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryMatrix({ rows }: { rows: { category: string; severity: string; count: number }[] }) {
  const cell = (cat: string, sev: string) => rows.filter((r) => r.category === cat && r.severity === sev).reduce((n, r) => n + r.count, 0);
  const cats = (Object.keys(CATEGORIES) as Category[]).filter((c) => SEVERITIES.some((s) => cell(c, s) > 0));
  if (!cats.length) return <p className="text-sm text-muted">No issues in any category.</p>;
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="table-head">
          <tr>
            <th className="h-9 px-3 text-left font-medium">Category</th>
            {SEVERITIES.map((s) => (
              <th key={s} className="h-9 px-3 text-right font-medium">
                {SEVERITY_LABEL[s]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cats.map((c) => (
            <tr key={c} className="border-t border-line-soft">
              <td className="px-3 py-2.5">
                <Link href={`/audit/issues${qs({ category: c })}`} className="underline-offset-4 hover:underline">
                  {CATEGORIES[c]}
                </Link>
              </td>
              {SEVERITIES.map((s) => {
                const n = cell(c, s);
                return (
                  <td key={s} className="data px-3 py-2.5 text-right">
                    {n ? (
                      <Link href={`/audit/issues${qs({ category: c, severity: s })}`} className="underline-offset-4 hover:underline">
                        {formatNumber(n)}
                      </Link>
                    ) : (
                      <span className="text-muted">–</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SinceLast({ hasPrevious, newUrls, fixedUrls, rows }: { hasPrevious: boolean; newUrls: number; fixedUrls: number; rows: IssueSummary[] }) {
  if (!hasPrevious) return <p className="text-sm text-muted">Shows changes once there are two crawls.</p>;
  if (!newUrls && !fixedUrls) return <p className="text-sm text-muted">No issues came or went.</p>;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <ChangeList title="New issues" total={newUrls} rows={rows.filter((r) => r.added > 0).map((r) => ({ ...r, n: r.added }))} tone="bad" />
      <ChangeList title="Fixed issues" total={fixedUrls} rows={rows.filter((r) => r.fixed > 0).map((r) => ({ ...r, n: r.fixed }))} tone="good" />
    </div>
  );
}

function ChangeList({ title, total, rows, tone }: { title: string; total: number; rows: { code: string; title: string; n: number }[]; tone: "good" | "bad" }) {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-medium">
        {title} <span className="data">{formatNumber(total)}</span>
      </h3>
      <ul className="flex flex-col gap-1">
        {rows.slice(0, 6).map((r) => (
          <li key={r.code} className="flex justify-between gap-2">
            <Link href={`/audit/issues/${r.code}`} className="min-w-0 truncate text-secondary underline-offset-4 hover:text-fg hover:underline">
              {r.title}
            </Link>
            <span className={`data ${tone === "good" ? "text-good" : "text-bad"}`}>
              {tone === "good" ? "−" : "+"}
              {formatNumber(r.n)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
