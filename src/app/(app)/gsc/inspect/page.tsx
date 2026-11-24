import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { formatDateTime, formatDateTimeZoned } from "@/lib/format";
import { inspectUrl } from "@/modules/google/actions";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { gscSource, inspectFigures, inspectSentence, plainState, VERDICT_WORDS } from "@/modules/google/brief";
import { recentInspections } from "@/modules/google/data";
import { GscBriefing, gscPropertyContext } from "@/modules/google/ui/context";
import { GscTabs } from "@/modules/google/ui/status";

export const metadata = { title: "URL inspection · Search Console" };

const TONE: Record<string, "good" | "warn" | "bad" | "neutral"> = { PASS: "good", NEUTRAL: "warn", PARTIAL: "warn", FAIL: "bad", ERROR: "bad" };

const verdictWords = (verdict: string | null) => (verdict ? (VERDICT_WORDS[verdict] ?? plainState(verdict)) : null);
const plain = (state: string | null) => (state ? plainState(state) : null);
/** Older failed inspections stored Google's error text as their coverage, so those show none. */
const coverageWords = (h: { verdict: string | null; coverageState: string | null }) => (h.verdict === "ERROR" ? null : plain(h.coverageState));

export default async function InspectPage({ searchParams }: PageProps<"/gsc/inspect">) {
  const sp = await searchParams;
  const ctx = await gscPropertyContext(sp);
  if (!ctx.ready) return ctx.view;
  const { project } = ctx;
  const [history, timeZone] = await Promise.all([recentInspections(projectScope(project)), currentTimeZone()]);
  const latest = history[0];
  const prefill = typeof sp.url === "string" ? sp.url : `https://${project.domain}/`;

  return (
    <>
      <PageHeader title="Search Console" description={`${gscSource(project.gscProperty)} · Google's index status for one URL. Quota: 2,000 a day per property.`} />
      <GscTabs />
      <GscBriefing sentence={inspectSentence(history)} figures={inspectFigures(history)} />

      <Card className="mt-6">
        <CardBody>
          <ActionForm action={inspectUrl.bind(null, project.id)} className="flex gap-2">
            <Input name="url" type="url" required defaultValue={prefill} placeholder="https://example.com/page" aria-label="URL to inspect" />
            <Button type="submit">Inspect</Button>
          </ActionForm>
        </CardBody>
      </Card>

      {latest && (
        <Section
          title="Latest inspection"
          description={`${latest.url} · inspected ${formatDateTimeZoned(latest.inspectedAt, timeZone)}`}
          actions={latest.verdict && <Badge tone={TONE[latest.verdict] ?? "neutral"}>{verdictWords(latest.verdict)}</Badge>}
        >
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm @2xl/main:grid-cols-2">
            {[
              ["Coverage", coverageWords(latest)],
              ["Indexing allowed", plain(latest.indexingState)],
              ["robots.txt", plain(latest.robotsTxtState)],
              ["Page fetch", plain(latest.pageFetchState)],
              ["Last crawl", latest.lastCrawlTime ? formatDateTime(latest.lastCrawlTime, timeZone) : null],
              ["Crawled as", plain(latest.crawledAs)],
              ["Google-selected canonical", latest.googleCanonical],
              ["Declared canonical", latest.userCanonical],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="truncate" title={v ?? undefined}>
                  {v ?? "–"}
                </dd>
              </div>
            ))}
          </dl>
          {latest.googleCanonical && latest.userCanonical && latest.googleCanonical !== latest.userCanonical && (
            <p className="mt-4 text-sm text-bad">Google picked a different canonical than the page declares.</p>
          )}
          {latest.inspectionResultLink && (
            <a href={latest.inspectionResultLink} target="_blank" rel="noreferrer" className="mt-4 inline-block text-sm text-accent underline-offset-3 hover:underline">
              Open in Search Console
            </a>
          )}
        </Section>
      )}

      <Section title="History">
        <DataTable
          filename={`${project.domain}-inspections`}
          columns={[
            { key: "when", label: "Inspected", data: true },
            { key: "url", label: "URL", format: "url" },
            { key: "verdictWords", label: "Verdict", format: "badge" },
            { key: "coverage", label: "Coverage" },
            { key: "lastCrawl", label: "Last crawl", data: true },
          ]}
          rows={history.map((h) => ({ ...h, when: formatDateTime(h.inspectedAt, timeZone), verdictWords: verdictWords(h.verdict), coverage: coverageWords(h), lastCrawl: h.lastCrawlTime ? formatDateTime(h.lastCrawlTime, timeZone) : "–" }))}
        />
      </Section>
    </>
  );
}
