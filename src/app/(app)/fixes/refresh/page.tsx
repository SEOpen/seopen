import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { NoProject } from "@/components/require-project";
import { BackLink } from "@/components/ui/back-link";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Figure } from "@/components/ui/figure";
import { Input, Label } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Section } from "@/components/ui/section";
import { isFree } from "@/lib/billing/gates";
import { rules } from "@/plan-policy/rules";
import { spendState } from "@/lib/billing/spend";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { getCurrentProject, type Project } from "@/lib/projects";
import { wantsRun } from "@/lib/run-request";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { WEIGHT_NOTE } from "@/modules/fixes/coverage";
import { onProjectDomain } from "@/modules/fixes/domain";
import { CHECKLIST_MIN_IMPRESSIONS, pageRefresh, REFRESH_DAYS, refreshHref, refreshSentence, type QuestionsState } from "@/modules/fixes/refresh";
import { urlPath } from "@/modules/google/brief";
import { RunPrompt } from "@/modules/keywords/components/research-ui";
import { keywordQuery, param } from "@/modules/keywords/market";
import { MAX_KEYWORD_LENGTH } from "@/modules/keywords/requests";

export const metadata = { title: "Refresh this page · Fixes" };

const LABEL = { covered: "Covered", partly: "Partly covered", missing: "Missing" } as const;
const TONE = { covered: "good", partly: "neutral", missing: "warn" } as const;

export default async function RefreshPage({ searchParams }: PageProps<"/fixes/refresh">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const url = typeof sp.url === "string" ? sp.url.trim() : "";
  const back = <BackLink href="/fixes">Fixes</BackLink>;
  if (!url || !onProjectDomain(url, project.domain)) {
    return (
      <>
        {back}
        <EmptyState
          level={1}
          title={url ? `That page isn't on ${project.domain}` : "No page given"}
          description="Open the panel from a page in Search Console's Pages or Opportunities, or from a fix."
          action={
            <Link href="/gsc/pages" className="text-accent hover:underline">
              Search Console pages
            </Link>
          }
        />
      </>
    );
  }
  const run = await wantsRun(sp.run);
  const { q: typed } = keywordQuery(param(sp.q));
  return (
    <>
      {back}
      <PageHeader
        title="Refresh this page"
        description={
          <>
            <span className="data [overflow-wrap:anywhere]">{urlPath(url)}</span>
            {" · "}
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline-offset-3 hover:underline">
              Open page
              <ExternalLink aria-hidden className="size-3" strokeWidth={1.5} />
            </a>
            {" · "}
            <Link href={`/gsc/page?url=${encodeURIComponent(url)}`} className="text-accent underline-offset-3 hover:underline">
              Its Search Console
            </Link>
          </>
        }
      />
      <Suspense fallback={<PageSkeleton header={false} label="Reading the page" />}>
        <Panel project={project} url={url} run={run} typed={typed} />
      </Suspense>
    </>
  );
}

async function Panel({ project, url, run, typed }: { project: Project; url: string; run: boolean; typed: string }) {
  const scope = projectScope(project);
  const [{ refusal, workspace }, timeZone] = await Promise.all([spendState(project.workspaceId), currentTimeZone()]);
  const free = isFree(workspace);
  const r = await pageRefresh(scope, project, url, { keyword: typed, mayBuy: async () => run && !refusal && !free });
  const read = r.page.from === "live" ? `the live page, read ${formatDateTime(r.page.at, timeZone)}` : r.page.from === "crawl" ? `the site audit crawl of ${formatDate(r.page.at, timeZone)}` : null;
  const missingOrPartly = r.searches.filter((s) => s.label !== "covered");

  return (
    <>
      <Briefing sentence={refreshSentence(r)}>
        <Figure label="Searches" value={formatNumber(r.searches.length)} caption={r.span ?? "No Search Console data"} />
        <Figure label="Missing" value={formatNumber(r.counts.missing)} caption="Under half their words on the page" />
        <Figure label="Partly covered" value={formatNumber(r.counts.partly)} caption="Half their words or more" />
        <Figure label="Covered" value={formatNumber(r.counts.covered)} caption="Every word on the page" />
      </Briefing>

      {r.page.note && (
        <div className="mt-6">
          <Callout tone="warn" title={r.page.from === "live" ? "Read without JavaScript" : "Couldn't read the live page"}>
            {r.page.note}
          </Callout>
        </div>
      )}

      <Section
        title="Searches this page doesn't cover"
        className="mt-6"
        description={
          read
            ? `Searches this page showed for, ${r.span ?? `the last ${REFRESH_DAYS} days`}, checked against the title, H1 to H3 and body text of ${read}. Stop words are ignored and word endings folded. Covered means every word is on the page, partly covered at least half. Where another page leads for a search, with more impressions at the same or a better position, it's that page's to cover, so it isn't on the checklist. ${WEIGHT_NOTE}`
            : "There's no copy of the page to check the searches against."
        }
      >
        {r.searches.length ? (
          <DataTable
            filename={`${project.domain}-refresh-searches`}
            columns={[
              { key: "query", label: "Search", format: "link", href: "/gsc/query?q={query}" },
              { key: "coverage", label: "On the page", format: "text" },
              { key: "absentWords", label: "Words not on the page", format: "text" },
              { key: "owner", label: "Another page leads", format: "text" },
              { key: "impressions", label: "Impressions", format: "number" },
              { key: "position", label: "Position", format: "position" },
              { key: "score", label: "Weighted impressions", format: "number" },
              { key: "source", label: "Source", format: "text" },
              { key: "dates", label: "Dates", format: "text" },
            ]}
            rows={r.searches.map((s) => ({ query: s.query, coverage: LABEL[s.label], absentWords: s.absent.join(", ") || "–", owner: s.ownedBy ? `${urlPath(s.ownedBy.page)}: ${formatNumber(s.ownedBy.impressions)} impressions at ${s.ownedBy.position}` : "–", impressions: s.impressions, position: s.position, score: s.score, source: "Search Console", dates: r.span?.replace(/^Search Console, /, "") ?? "" }))}
          />
        ) : (
          <p className="text-sm text-muted">{r.range ? `No searches with impressions for this page in the last ${REFRESH_DAYS} days.` : "Connect Search Console in Settings to see the searches this page shows for."}</p>
        )}
        {missingOrPartly.length === 0 && r.searches.length > 0 && <p className="mt-3 text-sm text-secondary">Every search this page showed for is on it.</p>}
      </Section>

      <Section title="Questions to answer" description="People also ask, from Google's live results, for the page's main search when you track it, else the best of its searches that you do track. When you track none, you can type one. The main search has the most impressions and doesn't name the site, preferring one the title or H1 is written for.">
        <Questions q={r.questions} url={url} typed={typed} timeZone={timeZone} free={free} refused={refusal?.message ?? null} />
      </Section>

      <Section title="On-page basics">
        {r.basics.length ? (
          <ul className="divide-y divide-line-soft">
            {r.basics.map((b) => (
              <li key={b.id} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">{b.finding}</span>
                  <Badge tone={b.ok ? "neutral" : "warn"}>{b.ok ? "Fine" : "Worth a look"}</Badge>
                </div>
                <p className="max-w-[72ch] text-xs text-muted [overflow-wrap:anywhere]">{b.evidence}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing to check yet: this needs the page&apos;s searches and a copy of the page, or a site audit for its links.</p>
        )}
      </Section>

      <Section title="Checklist" description={`What the sections above add up to, each with the data behind it: the top searches and questions, and basics worth a look. Searches with fewer than ${CHECKLIST_MIN_IMPRESSIONS} impressions stay off it. Suggestions only: what to cover, never the words to write.`}>
        {r.checklist.length ? (
          <ol className="flex list-decimal flex-col gap-3 pl-5">
            {r.checklist.map((c) => (
              <li key={c.id} className="max-w-[72ch]">
                <p className="text-sm [overflow-wrap:anywhere]">{c.task}</p>
                <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{c.evidence}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">Nothing on it: the page covers its searches and passes the basics checked here.</p>
        )}
        <p className="mt-4 max-w-[72ch] text-xs text-muted">What the top 3 results cover isn&apos;t shown: SEOpen&apos;s Google results lookup returns their titles and addresses, not their headings.</p>
      </Section>
    </>
  );
}

/** Starts empty on purpose: a lookup sends what the user types, never a Search Console search filled in for them. */
function TypeSearch({ url, label }: { url: string; label: string }) {
  return (
    <form action="/fixes/refresh" className="mt-4 flex flex-wrap items-end gap-2">
      <input type="hidden" name="url" value={url} />
      <div className="grid min-w-0 flex-[1_1_16rem] gap-1.5 sm:max-w-md">
        <Label htmlFor="q">{label}</Label>
        <Input id="q" name="q" required maxLength={MAX_KEYWORD_LENGTH} autoComplete="off" />
      </div>
      <Button type="submit" variant="secondary">
        See the price
      </Button>
    </form>
  );
}

function Questions({ q, url, typed, timeZone, free, refused }: { q: QuestionsState; url: string; typed: string; timeZone: string; free: boolean; refused: string | null }) {
  if (q.state === "no_search") return <p className="text-sm text-muted">There&apos;s no main search to look up yet.</p>;
  if (q.state === "untracked")
    return (
      <>
        <p className="max-w-[72ch] text-sm text-secondary [overflow-wrap:anywhere]">
          You don&apos;t track any of this page&apos;s searches. Its main one, “{q.main}”, is known only from Search Console, and Google data isn&apos;t sent to the search data provider. Track it in{" "}
          <Link href="/rank" className="text-accent underline-offset-3 hover:underline">
            Rankings
          </Link>
          {free ? "." : ", or type a search to look up."}
        </p>
        {!free && <TypeSearch url={url} label="Search to look up" />}
      </>
    );
  if (q.state === "failed") return <ApiError error={q.error} />;
  if (q.state === "priced") {
    if (free)
      return (
        <p className="max-w-[72ch] text-sm text-secondary">
          This needs a Google results lookup for “{q.keyword}”, which uses research credits, and Free has none.{" "}
          {rules.plansHref && (
            <Link href={rules.plansHref} className="text-accent underline-offset-3 hover:underline">
              See plans
            </Link>
          )}
        </p>
      );
    return (
      <RunPrompt
        title={`People also ask for “${q.keyword}” isn't loaded`}
        description="The live top 10 for it on Google, kept 7 days. Nothing is spent until you run it."
        href={`${refreshHref(url)}${typed ? `&q=${encodeURIComponent(typed)}` : ""}&run=1`}
        costUsd={q.usd}
        refused={refused}
      />
    );
  }
  return (
    <>
      <p className="mb-3 text-xs text-muted">
        For “{q.keyword}”, Google results {q.cached ? "saved" : "fetched"} {formatDateTime(q.at, timeZone)}.
      </p>
      {q.questions.length ? (
        <ul className="divide-y divide-line-soft">
          {q.questions.map((x) => (
            <li key={x.question} className="flex flex-wrap items-center gap-2 py-2.5">
              <span className="text-sm">{x.question}</span>
              <Badge tone={TONE[x.label]}>{x.label === "covered" ? "Words on the page" : LABEL[x.label]}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Google showed no People also ask box for it.</p>
      )}
    </>
  );
}

