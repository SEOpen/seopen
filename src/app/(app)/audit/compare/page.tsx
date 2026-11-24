import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { Delta } from "@/components/ui/delta";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { FilterBar } from "@/components/ui/filter-bar";
import { Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { changeDelta, countOf } from "@/lib/brief";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import { currentTimeZone } from "@/lib/workspace/current";
import { compareFigures, compareOverall, compareSentence } from "@/modules/audit/brief";
import { AuditTabs, SeverityBadge, first, qs } from "@/modules/audit/components/bits";
import { diffCrawls } from "@/modules/audit/diff";
import { doneCrawls, issueRows, type CrawlRow } from "@/modules/audit/queries";
import { ISSUES, SEVERITIES, SEVERITY_LABEL } from "@/modules/audit/taxonomy";

export const metadata = { title: "Compare crawls" };

export default async function ComparePage({ searchParams }: PageProps<"/audit/compare">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const [crawls, timeZone] = await Promise.all([doneCrawls(projectScope(project), 100), currentTimeZone()]);

  if (crawls.length < 2) {
    return (
      <>
        <PageHeader title="Site audit" description={`Compare two crawls of ${project.domain}.`} />
        <AuditTabs />
        <EmptyState
          title="Needs two finished crawls"
          description={`You have ${crawls.length ? "one" : "none"} so far. Run another crawl, or turn on the weekly re-crawl, and the comparison shows up here.`}
          action={<ButtonLink href="/audit#new-crawl">Start a crawl</ButtonLink>}
        />
      </>
    );
  }

  const pick = (v: string | undefined, fallback: CrawlRow) => crawls.find((c) => c.id === Number(v)) ?? fallback;
  const b = pick(first(sp.b), crawls[0]);
  const a = pick(first(sp.a), crawls.find((c) => c.id !== b.id) ?? crawls[1]);
  const code = first(sp.code);
  const show = first(sp.show) === "fixed" ? "fixed" : "added";

  const [ra, rb] = await Promise.all([issueRows(a), issueRows(b)]);
  const diff = diffCrawls(ra, rb);
  const selected = code ? diff.codes.find((c) => c.code === code) : undefined;
  const selectedUrls = selected ? (show === "fixed" ? selected.fixed : selected.added) : [];

  const general = compareOverall(a, b, diff.totals);

  return (
    <>
      <PageHeader title="Site audit" description={`Two crawls of ${project.domain}, side by side.`} />
      <AuditTabs />
      <Briefing sentence={compareSentence(a, b, diff.totals, timeZone)}>
        {compareFigures(a, b, diff.totals, timeZone).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>

      <FilterBar action="/audit/compare" className="mt-6 mb-0">
        <Label>
          Earlier crawl (A)
          <Select name="a" defaultValue={a.id}>
            <CrawlOptions crawls={crawls} timeZone={timeZone} />
          </Select>
        </Label>
        <Label>
          Later crawl (B)
          <Select name="b" defaultValue={b.id}>
            <CrawlOptions crawls={crawls} timeZone={timeZone} />
          </Select>
        </Label>
      </FilterBar>

      <div className="module-rail">
        <div>
          {SEVERITIES.map((sev) => {
            const rows = diff.codes.filter((c) => c.severity === sev && ISSUES[c.code]);
            if (!rows.length) return null;
            return (
              <Section key={sev} title={SEVERITY_LABEL[sev]}>
                <div className="panel overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="table-head">
                      <tr>
                        <th className="h-9 px-3 text-left font-medium">Check</th>
                        <th className="h-9 px-3 text-right font-medium">A</th>
                        <th className="h-9 px-3 text-right font-medium">B</th>
                        <th className="h-9 px-3 text-right font-medium">New</th>
                        <th className="h-9 px-3 text-right font-medium">Fixed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.code} className={cn("border-t border-line-soft", r.code === code && "bg-accent-subtle")}>
                          <td className="min-w-40 px-3 py-2">
                            <Link href={`/audit/issues/${r.code}${qs({ crawl: b.id })}`} className="underline-offset-4 hover:underline">
                              {ISSUES[r.code].title}
                            </Link>
                          </td>
                          <td className="data px-3 py-2 text-right">{formatNumber(r.before)}</td>
                          <td className="data px-3 py-2 text-right">{formatNumber(r.after)}</td>
                          <td className="data px-3 py-2 text-right">
                            {r.added.length ? (
                              <Link href={`/audit/compare${qs({ a: a.id, b: b.id, code: r.code, show: "added" })}#urls`} className="text-bad underline-offset-4 hover:underline">
                                +{formatNumber(r.added.length)}
                              </Link>
                            ) : (
                              <span className="text-muted">–</span>
                            )}
                          </td>
                          <td className="data px-3 py-2 text-right">
                            {r.fixed.length ? (
                              <Link href={`/audit/compare${qs({ a: a.id, b: b.id, code: r.code, show: "fixed" })}#urls`} className="text-good underline-offset-4 hover:underline">
                                −{formatNumber(r.fixed.length)}
                              </Link>
                            ) : (
                              <span className="text-muted">–</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            );
          })}
          {!diff.codes.some((c) => ISSUES[c.code]) && (
            <Section title="Checks">
              <p className="text-sm text-muted">Neither crawl found any issues.</p>
            </Section>
          )}

          {selected && (
            <div id="urls" className="scroll-mt-6">
              <Section
                title={`${ISSUES[selected.code]?.title}: ${show === "fixed" ? "fixed" : "new"} in the later crawl`}
                description={
                  <span className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={selected.severity} />
                    {countOf(selectedUrls.length, "URL")}
                  </span>
                }
              >
                <ul className="panel divide-y divide-line-soft text-sm">
                  {selectedUrls.map((u) => (
                    <li key={u} className="truncate px-3 py-2">
                      <a href={u} target="_blank" rel="noreferrer" className="text-secondary underline-offset-4 hover:underline">
                        {u.replace(/^https?:\/\//, "")}
                      </a>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>
          )}
        </div>

        <div>
          <Section title="Overall" description="A is the earlier crawl, B the later one.">
            <div className="panel overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="table-head">
                  <tr>
                    <th className="h-9 px-3 text-left font-medium">
                      <span className="sr-only">Measure</span>
                    </th>
                    <th className="h-9 px-2 text-right font-medium">A</th>
                    <th className="h-9 px-2 text-right font-medium">B</th>
                    <th className="h-9 px-3 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {general.map((g) => {
                    const d = g.change;
                    return (
                      <tr key={g.label} className="border-t border-line-soft">
                        <td className="px-3 py-2 text-muted">{g.label}</td>
                        <td className="data px-2 py-2 text-right">{g.a == null ? "" : formatNumber(g.a)}</td>
                        <td className="data px-2 py-2 text-right">{formatNumber(g.b)}</td>
                        <td className="px-3 py-2 text-right">{d == null ? "" : d === 0 ? <span className="data text-muted">–</span> : <Delta {...changeDelta(d, "decimal", g.goodWhen)} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

function CrawlOptions({ crawls, timeZone }: { crawls: CrawlRow[]; timeZone: string }) {
  return crawls.map((c) => (
    <option key={c.id} value={c.id}>
      {formatDateTime(c.finishedAt, timeZone)} · {formatNumber(c.pagesCrawled)} pages
    </option>
  ));
}
