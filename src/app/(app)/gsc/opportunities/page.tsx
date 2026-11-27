import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { formatDate, formatNumber } from "@/lib/format";
import { projectScope, workspaceTimeZone } from "@/lib/workspace";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { gscSource, noisyNote, opportunitiesSentence, opportunityFigures, pageLabels, searchConsoleSpan, urlPath } from "@/modules/google/brief";
import { likelyBotNote } from "@/modules/google/bot-queries";
import { gscByQuery, gscPagesSincePrevious, gscStrikingPages, topPageByQuery } from "@/modules/google/data";
import { declining, lowCtr, parseRange, rangeKey, STRIKING_FORMULA, STRIKING_RANGES, strikingDistance, strikingMinImpressions } from "@/modules/google/insights";
import { GscBriefing, gscContext } from "@/modules/google/ui/context";
import { GscTable } from "@/modules/google/ui/gsc-table";
import { hrefWith, PeriodControls } from "@/modules/google/ui/period";
import { GscTabs } from "@/modules/google/ui/status";
import { brandTerms } from "@/modules/fixes/coverage";
import { latestCrawlPages, opportunityHints } from "@/modules/fixes/opportunity-hints";

export const metadata = { title: "Opportunities · Search Console" };

/** The most rows each table shows. */
const TABLE_ROWS = 200;

/** What a table leaves out, for the end of its description. */
const shownNote = (total: number, order: string) => (total > TABLE_ROWS ? ` The table shows the ${TABLE_ROWS} ${order}.` : "");

export default async function OpportunitiesPage({ searchParams }: PageProps<"/gsc/opportunities">) {
  const sp = await searchParams;
  const ctx = await gscContext(sp);
  if (!ctx.ready) return ctx.view;
  const { project, periods, choice, data } = ctx;

  // Thresholds scale with the period so a 7-day view still finds something.
  const scale = Math.max(choice.days / 28, 0.25);
  const minPrevClicks = Math.max(3, Math.round(10 * scale));
  const [lo, hi] = String(sp.positions ?? "").split("-");
  const positions = parseRange(lo, hi);
  const byPage = sp.group !== "query";
  const [queries, prevPages, close] = await Promise.all([
    gscByQuery(projectScope(project), periods.current, periods.previous),
    // Driven from the compare period, so pages that lost all their clicks still show up.
    periods.previous ? gscPagesSincePrevious(projectScope(project), periods.current, periods.previous, minPrevClicks) : [],
    byPage ? gscStrikingPages(projectScope(project), periods.current, { positions, minImpressions: strikingMinImpressions(choice.days) }) : null,
  ]);
  // The tables show the top of each list; the counts and the missed clicks read the whole of it.
  const allStriking = strikingDistance(queries, strikingMinImpressions(choice.days), positions);
  // Expected CTR is only meaningful per query: a page's position averages many queries.
  const allLow = lowCtr(queries, Math.round(100 * scale));
  const allDown = declining(prevPages, minPrevClicks);
  const striking = allStriking.slice(0, TABLE_ROWS);
  const low = allLow.slice(0, TABLE_ROWS);
  const down = allDown.slice(0, TABLE_ROWS);
  const closePages = close?.pages.slice(0, TABLE_ROWS) ?? [];
  const bestPage = await topPageByQuery(projectScope(project), periods.current, [...(byPage ? closePages.map((p) => p.topQuery.query) : striking.map((r) => r.key)), ...low.map((r) => r.key)]);
  // What to change, from the newest crawl: on each listed page, or on each listed search's best page.
  const hintPages = byPage ? closePages.map((p) => p.page) : striking.map((r) => bestPage.get(r.key)).filter((p): p is string => !!p);
  const [crawl, timeZone] = await Promise.all([latestCrawlPages(projectScope(project), hintPages), workspaceTimeZone(projectScope(project))]);
  const brand = brandTerms(project.domain);
  const hintFor = (query: string, page: string | undefined, best: string | undefined) =>
    !page || !crawl ? "" : opportunityHints({ query, page, bestPage: best, crawl: crawl.pages.get(page) ?? null, medianLinksIn: crawl.medianLinksIn, brand }).join("; ");
  const crawlNote = crawl
    ? ` What to change is what the site audit crawl${crawl.at ? ` of ${formatDate(crawl.at, timeZone)}` : ""} found on the page; Refresh this page reads the live one.`
    : " Run a site audit to see what to change on each page.";
  const withPage = (r: { key: string }): Record<string, unknown> => {
    const page = bestPage.get(r.key) ?? "";
    return { ...r, page, pagePath: page ? urlPath(page) : "", botNote: likelyBotNote(r.key) };
  };
  // A Note column only when a listed search looks like another tool's rank check.
  const botColumn = (rows: { key: string }[]) => (rows.some((r) => likelyBotNote(r.key)) ? [{ key: "botNote", label: "Note", format: "badge" as const }] : []);
  const hasPage = (rows: { key: string }[]) => rows.some((r) => bestPage.has(r.key));
  const downLabel = pageLabels(down.map((r) => r.key));
  const counts = { striking: allStriking.length, low: allLow.length, declining: allDown.length, missedClicks: allLow.reduce((n, r) => n + r.missedClicks, 0), queriesRead: queries.length, range: positions };
  const win = { periods, compare: choice.compare, first: data.first };
  const span = searchConsoleSpan(periods.current);
  const noisy = noisyNote(data);
  const closeLabel = pageLabels(closePages.map((p) => p.page));
  const path = "/gsc/opportunities";
  const strikingControls = (
    <>
      <SegmentedLinks label="Positions" options={STRIKING_RANGES.map((r) => ({ href: hrefWith(path, sp, { positions: rangeKey(r) }), label: `${r.min}–${r.max}`, active: rangeKey(r) === rangeKey(positions) }))} />
      <SegmentedLinks
        label="Group"
        options={[
          { href: hrefWith(path, sp, { group: "page" }), label: "Group by page", active: byPage },
          { href: hrefWith(path, sp, { group: "query" }), label: "By query", active: !byPage },
        ]}
      />
    </>
  );

  return (
    <>
      <PageHeader title="Search Console" description={gscSource(project.gscProperty, data.last)} actions={<PeriodControls path="/gsc/opportunities" sp={sp} choice={choice} />} />
      <GscTabs />
      <GscBriefing sentence={opportunitiesSentence(counts)} figures={opportunityFigures(counts, win, choice.days)} />
      {byPage && close ? (
        <Section
          title={`Pages close to the top (${formatNumber(close.pages.length)})`}
          className="mt-6"
          actions={strikingControls}
          description={
            <>
              <p>
                Pages whose searches sit at average position {positions.min}–{positions.max}, by the page Google showed for each search. Sorted by{" "}
                <span title={STRIKING_FORMULA} tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">
                  score
                </span>
                , which favours many impressions close to page one. {span}.{shownNote(close.pages.length, "with the highest scores")}
                {crawlNote}
                {close.truncated ? " Read from the searches with the most impressions only." : ""}
              </p>
              {noisy && <p className="mt-1 text-warn">{noisy}</p>}
            </>
          }
        >
          <DataTable
            filename={`${project.domain}-striking-distance-pages`}
            initialSort={{ key: "score", desc: true }}
            columns={[
              { key: "path", label: "Page", format: "link", href: "/gsc/page?url={page}" },
              { key: "score", label: "Score", format: "number" },
              { key: "queries", label: "Searches in range", format: "number" },
              { key: "impressions", label: "Impressions", format: "number" },
              { key: "bestPosition", label: "Best position", format: "position" },
              { key: "topQuery", label: "Top search", format: "link", href: "/gsc/query?q={topQuery}" },
              { key: "topPosition", label: "Its position", format: "position" },
              ...(crawl ? [{ key: "hint", label: "What to change", format: "text" as const }] : []),
              { key: "refresh", label: "Refresh", format: "link", href: "/fixes/refresh?url={page}" },
            ]}
            rows={closePages.map((p) => ({ page: p.page, path: closeLabel(p.page), score: Math.round(p.score), queries: p.queries, impressions: p.impressions, bestPosition: p.bestPosition, topQuery: p.topQuery.query, topPosition: p.topQuery.position, hint: hintFor(p.topQuery.query, p.page, bestPage.get(p.topQuery.query)), refresh: "Refresh this page" }))}
          />
        </Section>
      ) : (
        <Section
          title={`Close to the top (${formatNumber(counts.striking)})`}
          className="mt-6"
          actions={strikingControls}
          description={
            <>
              <p>{`Queries at average position ${positions.min}–${positions.max} with real impressions. A small ranking gain moves them onto page one or into the top few results. ${span}.${shownNote(counts.striking, "with the most impressions")}${hasPage(striking) ? crawlNote : ""}`}</p>
              {noisy && <p className="mt-1 text-warn">{noisy}</p>}
            </>
          }
        >
          <DataTable
            filename={`${project.domain}-striking-distance`}
            initialSort={{ key: "impressions", desc: true }}
            columns={[
              { key: "key", label: "Query", format: "link", href: "/gsc/query?q={key}" },
              { key: "position", label: "Position", format: "position" },
              { key: "impressions", label: "Impressions", format: "number" },
              { key: "clicks", label: "Clicks", format: "number" },
              { key: "ctr", label: "CTR", format: "pct" },
              ...(hasPage(striking) ? [{ key: "pagePath", label: "Best page", format: "link" as const, href: "/gsc/page?url={page}" }] : []),
              ...(crawl && hasPage(striking) ? [{ key: "hint", label: "What to change", format: "text" as const }] : []),
              ...botColumn(striking),
            ]}
            rows={striking.map((r) => ({ ...withPage(r), hint: hintFor(r.key, bestPage.get(r.key), bestPage.get(r.key)) }))}
          />
        </Section>
      )}

      <Section
        title={`Fewer clicks than expected (${formatNumber(counts.low)})`}
        description={`Top-10 queries getting under half the clicks a typical result at that position gets. Rewrite the ranking page's title and description, or check which search features push it down.${shownNote(counts.low, "missing the most clicks")}`}
      >
        <DataTable
          filename={`${project.domain}-low-ctr`}
          initialSort={{ key: "missedClicks", desc: true }}
          columns={[
            { key: "key", label: "Query", format: "link", href: "/gsc/query?q={key}" },
            { key: "position", label: "Position", format: "position" },
            { key: "impressions", label: "Impressions", format: "number" },
            { key: "ctr", label: "CTR", format: "pct" },
            { key: "expectedCtr", label: "Expected", format: "pct" },
            { key: "missedClicks", label: "Missed clicks", format: "number" },
            ...(hasPage(low) ? [{ key: "pagePath", label: "Ranking page", format: "link" as const, href: "/gsc/page?url={page}" }] : []),
            ...botColumn(low),
          ]}
          rows={low.map(withPage)}
        />
      </Section>

      <Section
        title={`Pages losing clicks (${formatNumber(counts.declining)})`}
        description={periods.previous ? `Pages whose clicks fell 30% or more against the compare period.${shownNote(counts.declining, "that lost the most clicks")}` : "Pick a compare period to find declining pages."}
      >
        <GscTable
          filename={`${project.domain}-declining`}
          initialSort={{ key: "lostClicks", desc: true }}
          columns={[
            { key: "path", label: "Page", format: "link", href: "/gsc/page?url={key}" },
            { key: "prevClicks", label: "Before", format: "number" },
            { key: "clicks", label: "Now", format: "number" },
            { key: "change", label: "Change", format: "pct" },
            { key: "lostClicks", label: "Lost clicks", format: "number" },
            { key: "positionDelta", label: "Position change", format: "position-change" },
          ]}
          rows={down.map((r) => ({ ...r, path: downLabel(r.key) }))}
        />
      </Section>
    </>
  );
}
