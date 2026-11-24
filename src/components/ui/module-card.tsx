/**
 * Dashboard module cards: the contract every module follows, and the pieces it builds with.
 *
 * Reference implementation: src/modules/google/dashboard.tsx and its dashboard.fixtures.ts.
 * Copy their shape. Preview every state at /dev/cards (dev only) before you commit.
 *
 * ─── 1. What a module exports ────────────────────────────────────────────────────────────────
 *
 * src/modules/<name>/dashboard.tsx exports ONE thing, `dashboard`, typed DashboardModule<Data>:
 *
 *   export interface RankDashboardData { ... }              // plain, serializable data
 *   export const dashboard: DashboardModule<RankDashboardData> = {
 *     id: "rank",
 *     label: "Rankings",                                     // card title and setup-row name
 *     href: "/rank",                                         // title link and "View →"
 *     setup: { text: "no tracked keywords yet", href: "/rank" },
 *     load,                                                  // (project) => Promise<Data | null>
 *     describe: (d) => `${formatNumber(d.keywords)} keywords · last check ${formatDay(d.date)}`,
 *     baseline: (d) => (d.previous ? formatDay(d.previous.date) : null),
 *     changes: (d) => [compare("On page one", d.top10, d.previous?.top10), ...],
 *     View,                                                  // ({ data }) => card body
 *   };
 *
 * A new module adds its `dashboard` to DASHBOARD_MODULES in src/app/(app)/dashboard-modules.ts and
 * its `fixtures` to FIXTURES in src/app/(app)/dev/cards/page.tsx. The dashboard needs no change.
 *
 * Where cards are used: src/app/(app)/project-dashboard.tsx draws one project's dashboard (at
 * /projects/[id], and at / when the workspace has one project); dashboard-load.ts runs the
 * loaders. The projects overview at / runs the same loaders for every project, one Suspense
 * boundary per row, and project-summary.ts reads its columns from the Search Console, rank,
 * audit and AI data, plus the biggest of every module's `changes`.
 *
 * `load(project)`
 *   - Database reads only. Never an API call (DataForSEO costs money), never a write.
 *   - Return null when the module has nothing to show. The dashboard then lists it as a one-line
 *     "Not set up" row built from `label` + `setup`. Do not render a placeholder card.
 *   - Throwing is fine: the page catches it and shows an error row for this module only.
 *   - Run independent queries with Promise.all. Every loader runs in parallel on each
 *     dashboard load, and again for each project on the overview (10 projects × 8 loaders took
 *     about 50 ms locally on 2026-10-30), so keep each one to a few indexed queries. If that
 *     stops being fast enough, add a lean optional summary loader here rather than slowing rows.
 *   - Return plain data: strings, numbers, booleans, arrays, null. Dates as "YYYY-MM-DD" or ISO
 *     strings, never Date objects (fixtures must be writable by hand). Do the math here
 *     (changes, comparisons, series) so the View only formats.
 *
 * `View({ data })`
 *   - Pure and synchronous: no fetching, no hooks, no "use client". It may render client
 *     components (charts) with serializable props.
 *   - Returns the section's figures only: one or more <ModuleSection>s. ModuleFrame draws the left
 *     column (title link with its arrow, `describe(data)` · "vs <baseline>"), so every section's head
 *     is identical. Never render <Card>, <CardHeader> or your own "Open" link inside a View. Numbers
 *     go through <Kpi>, which draws the same Figure the rest of the app uses.
 *
 * `describe(data)`: the header subline. Say what period or snapshot the numbers cover. Don't say
 * what the changes compare against; that's `baseline`.
 *
 * `baseline(data)`: what every change on the card compares against, short and lowercase:
 * "previous 28 days", formatDay(previous.date), "previous crawl", "previous run". The frame
 * appends it to the subline as "· vs …", and the dashboard's "What changed" summary prints it
 * beside each change, because modules compare against different windows (28 days, about a week,
 * the last crawl) and a bare "+12%" can't say which. Return null when there's nothing earlier
 * (the frame then says "nothing earlier to compare"). Omit it when the card shows no changes.
 *
 * `changes(data)`: the card's KPI changes as data, for the "What changed" summary. One
 * compare(label, current, previous, { unit, goodWhen, format }) per Kpi that has a `delta`, with
 * the same label and goodWhen; compare() returns null when either side is missing. The
 * summary shows the biggest ones across all modules, so list every change the card shows. Add
 * `count: true` for a count whose Kpi uses countDeltaFromZero, so the row reads the same as the figure;
 * `rank: true` for a ranking position ("improved 2 places") and, for a rate or average, `volume`
 * (the smaller period's impressions or sessions) so moves on a handful of visits are skipped.
 *
 * Setup rows: `setup.text` is lowercase and finishes "<label>: …", read as one line:
 * "Rankings: no tracked keywords yet". `setup.href` is the page where the user takes the
 * first step. Use these:
 *
 *   id         label                 href               setup.text                     setup.href
 *   google     Search Console        /gsc               no Search Console data yet     /gsc
 *   ga4        Analytics             /ga4               no Analytics data yet          /ga4
 *   rank       Rankings              /rank              no tracked keywords yet        /rank
 *   local      Local SEO             /local             no Google Maps listing tracked yet  /local
 *   domains    Domain analysis       /domains           no domain snapshot yet         /domains
 *   audit      Site audit            /audit             no crawl yet                   /audit
 *   fixes      Fixes                 /fixes             nothing found to fix yet       /fixes
 *   backlinks  Backlinks             /backlinks         no backlink snapshot yet       /backlinks
 *   ai         AI visibility         /ai                no tracked prompts yet         /ai/prompts
 *   keywords   Keyword lists         /keywords/lists    no saved keyword lists yet     /keywords/lists
 *
 * ─── 2. Fixtures ─────────────────────────────────────────────────────────────────────────────
 *
 * src/modules/<name>/dashboard.fixtures.ts exports `fixtures: DashboardFixtures<Data>`. Three required states, plus any the module has of its own:
 *   full    realistic data with a previous period, so every change shows
 *   sparse  first snapshot only: no previous period, so no changes, short or no chart series
 *   long    the widest values the formatters can produce (99,999 / 48.2M / $1,234,567,
 *           +1,234.5%, long list names) to prove nothing overflows at 390px
 *   more    named extra states, e.g. audit: { "first crawl running": ..., "crawl running": ... }
 * Type fixtures against the module's Data type so they break when the data shape changes.
 *
 * ─── 3. Building the body ────────────────────────────────────────────────────────────────────
 *
 * A module is one borderless row of the Overview, with a hairline between modules: its title on the
 * left, then these sections stacked on the right, with space and no divider between them. Typical
 * body: a KPI row, then a chart. Don't repeat a number the readout strip above already shows.
 *
 *   <ModuleSection>
 *     <KpiRow>
 *       <Kpi label="Clicks" value={formatNumber(d.clicks)} delta={countDelta(d.clicks, d.previousClicks)} />
 *       <Kpi label="Search Console position" value={d.position.toFixed(1)} delta={deltaBetween(d.position, d.previousPosition, "decimal", "down", true)} />
 *     </KpiRow>
 *   </ModuleSection>
 *   <ModuleSection>
 *     <Trend points={d.points} label="Clicks" counts height={120} table={false} />
 *   </ModuleSection>
 *
 * KPIs (<KpiRow> + <Kpi>): the ONLY way a dashboard card shows a number with its change.
 *   - <Kpi> is a small <Figure>: label, value, change, then any hint. Never hand-roll a tile grid
 *     or a bordered/filled tile.
 *   - The row wraps by itself (no fixed columns), on one column width, so figures line up from one
 *     module to the next and 4 KPIs go 2×2 at 390px. Up to 4 KPIs per row; more means the module is
 *     doing too much. A long label wraps without pushing its value out of line with its neighbours.
 *   - `value` is a formatted string: formatNumber, formatPct, formatUsd(n, 0), n.toFixed(1),
 *     or "–" when unknown. Values are never colored.
 *   - `delta` is a ChangeDelta, built the way every other figure in the app builds one. Null (or
 *     omitted) when there is no baseline; the change disappears.
 *       countDelta(now, before)     a count: a percentage, or the plain difference when either side
 *                                   is under 50, so 14 → 37 reads "+23" rather than "+164%". Money
 *                                   stays a percentage: changeDelta(ratio, "percent")
 *       countDeltaFromZero(now, before)   the same, but a count that starts from zero still shows its
 *                                   plain difference, where countDelta has nothing for 0 → 60
 *       deltaBetween(now, before, unit, goodWhen, rank)   the rest, null when either side is missing:
 *         "number"   absolute count difference      12 → "+12"
 *         "points"   difference of two ratios       0.014 → "+1.4 pts", 0.01 → "+1 pt" (visibility, CTR, share)
 *         "decimal"  plain one-decimal difference   -2.3 → "−2.3"      (health score)
 *         rank       a position, where lower is better: "2.3 better", arrow up
 *       changeDelta(change, unit, goodWhen, rank)   when load has already stored the difference
 *   - `goodWhen`: "up" (default), "down" for positions and error counts. A change that rounds to
 *     zero reads "No change".
 *   - The change carries a screen-reader-only "(better)" or "(worse)", since its color says which.
 *   - `hint`: only when ONE KPI needs a different comparison or a footnote than the header says,
 *     e.g. hint="spam score 4" on Dofollow. Not a place to repeat the header's "vs …".
 *
 * Charts go in their own <ModuleSection>, height 120, one series. Trend and MetricChart are
 * role="img" with a generated summary ("Clicks, Sep 30 to Oct 27: latest 1, high 5, low 0"), not
 * keyboard stops, so they need no label from you.
 *   - Trend (components/ui/trend) takes raw dates and draws what the data has earned: a note for a
 *     point or two, weekly columns for sparse `counts`, a line otherwise. Height 120, table={false}.
 *   - Ratios (visibility %) use rank's MetricChart with a single metric (no switcher shows for
 *     one metric) and format "pct".
 *   - Render the section when the series has any points. Sparse fixtures prove the card still
 *     looks finished.
 *
 * Status lines (<ModuleNote>) for state, not numbers: audit's running crawl is
 *   <ModuleSection><ModuleNote live>Crawl running: 120 of 500 pages</ModuleNote></ModuleSection>
 * `live` adds a pulsing dot (still under reduced motion) and role="status". When the first
 * crawl is still running and nothing is finished, load returns data with no latest crawl (not
 * null): describe says "Crawl running, no results yet", KPIs show "–".
 *
 * Lists (keyword lists, top items): <ModuleSection><ModuleList> with <ModuleListItem
 * href label meta /> rows, at most 5. Label truncates; meta is short
 * ("1,204 keywords · 18.3K searches/mo") and wraps under the label on a narrow card. Say how
 * many there are in describe(); a list needs no KPI row above it.
 *
 * ─── 4. Per-module notes ─────────────────────────────────────────────────────────────────────
 *
 * A metric has one name and one format here, in the readout strip, in What changed and on its own
 * page. A number the strip shows stays in `changes` and leaves the View. Two positions sit on the one
 * page, so they say whose: "Search Console position" and "Tracked position". What changed names each
 * row's module, so Rankings' "Visibility" stands beside "AI visibility".
 *
 * google     KPIs Impressions (countDelta), CTR (points), Search Console position (decimal, goodWhen
 *            "down", rank); `changes` also has Clicks. describe "28 days to Oct 27, 2026", baseline
 *            "previous 28 days".
 * ga4        Lives in src/modules/google/ga4-dashboard.tsx (google owns /gsc and /ga4; ids are
 *            unique). KPIs Organic sessions, Key events (countDelta), Engagement rate (points:
 *            engaged / sessions, "–" with no sessions), Revenue (a percentage, formatUsd(n, 0)) only
 *            when either window has revenue. Same 28-day windows as google: describe "28 days to
 *            Oct 27, 2026", baseline "previous 28 days". Chart: Trend of daily sessions.
 * rank       KPIs Visibility (points), Top 3 (count), each with hint "7.2 pts not confirmed" or "2 not
 *            confirmed" when positions no look confirmed move it; `changes` also has On page one
 *            (number, the plain difference the strip shows; goodWhen "neither" when the whole gain is
 *            unconfirmed) and
 *            Tracked position (decimal, goodWhen "down", rank), all against the check nearest 7 days
 *            earlier; keep shiftBack in load. describe: "48 keywords · last check Oct 27, 2026",
 *            baseline "Oct 20, 2026". Chart: MetricChart, one "pct" metric, height 120.
 * local      KPIs Avg. map rank (decimal, goodWhen "down", rank), Top 3, Points found (value "15 of
 *            150", change in points). describe: "2 listings · 5 keywords · last check Nov 2, 2026",
 *            baseline the check before.
 * domains    KPIs Keywords, Est. traffic, Top 10 (count), Traffic value (no change).
 *            describe: "Estimates for x.com · Oct 1, 2026", baseline the month before, "Sep 2026". Chart: Trend
 *            of traffic history.
 * audit      KPIs Errors / Warnings / Notices (count, goodWhen "down"); `changes` also has Health
 *            score (number), all vs the previous crawl. describe: "Crawled Oct 27, 2026 · 1,204 pages", baseline
 *            "previous crawl". Running crawl: ModuleNote live. Fixture states in `more`: "first
 *            crawl running", "crawl running".
 * backlinks  KPIs Referring domains, Backlinks (number), Followed links (formatPct, no change,
 *            hint "spam score 4"). describe: "As of Oct 27, 2026", baseline "Oct 20, 2026". Chart:
 *            Trend of referring domains.
 * ai         KPIs AI visibility (points), Answers naming you (value "12 of 40").
 *            No chart. Store lastRunAt as an ISO string. describe: "Latest answers Oct 27, 2026",
 *            baseline "previous run".
 * keywords   No KPI row: one ModuleList of up to 5 lists, meta
 *            "1,204 keywords · 18.3K searches/mo". describe: "6,210 saved keywords in 7 lists".
 *            Long fixture: a 120-character list name and 99,999-keyword counts.
 *
 * Beyond the one line each in dashboard-modules.ts and the /dev/cards page, don't edit the
 * dashboard or those files: they pick up your `dashboard` and `fixtures` exports. Check /dev/cards at 390px and 1440px,
 * light and dark, then `pnpm typecheck && pnpm lint && pnpm test`.
 *
 * ─── 5. Formatting rules ─────────────────────────────────────────────────────────────────────
 *
 * - Every date a person reads goes through lib/format, never raw "2026-10-27". A calendar date
 *   ("YYYY-MM-DD") uses formatDay, which never shifts. An instant uses formatDate / formatDateTime
 *   with the workspace's zone: `describe` and `baseline` are pure, so `load` puts
 *   `workspaceTimeZone(project)` in the data; audit/dashboard.tsx shows the pattern. If you build
 *   a calendar string with a time yourself, use `${date}T12:00:00` (noon), not T00:00:00Z, or the
 *   day shifts in US time zones; domains/dashboard.tsx shows the pattern.
 * - Numbers: formatNumber (compacts at 100K), formatPct for ratios, formatUsd(n, 0) for money.
 * - Copy is sentence case, no trailing periods in describe(), baseline() or setup.text.
 */
import { ArrowRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { Children, useId, type ComponentProps, type ReactNode } from "react";
import type { CheckFailure } from "@/lib/check-failure";
import type { Project } from "@/lib/projects";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Digits } from "./delta";
import { Figure } from "./figure";
import type { ChangeDelta } from "./what-changed";

// ─── Contract types ───────────────────────────────────────────────────────────────────────────

export interface DashboardModule<Data> {
  /** Unique id, usually the folder name under src/modules ("ga4" lives in google). */
  id: string;
  /** Card title and the name in its setup row. */
  label: string;
  /** The module's main page: title link and "View →". */
  href: string;
  /** Shown as "<label>: <text> · Set up →" when load returns null. */
  setup: { text: string; href: string };
  /** Database reads only. Null means nothing to show yet. */
  load(project: Project): Promise<Data | null>;
  /**
   * Asked only when load returns null: what is already set up and waiting for its first results,
   * lowercase and read after the label ("Rankings: 8 keywords tracked, waiting for the first
   * check"), or null when nothing is set up. Database reads only.
   */
  waiting?(project: Project): Promise<string | null>;
  /**
   * For a module that checks something on its own: the projects whose newest check failed, or whose
   * connection needs redoing. A newer success clears it and a check in flight isn't one. All projects
   * asks once for every project, so read them together rather than one query each. Database reads only.
   */
  failures?(projects: Project[], timeZone: string): Promise<Map<number, CheckFailure>>;
  /** Header subline: the period or snapshot the numbers cover. */
  describe(data: Data): ReactNode;
  /** What the changes compare against ("previous 28 days", a date). Null says "nothing earlier to compare". Undefined says nothing: the changes have no baseline, but other data on the card may be older. */
  baseline?(data: Data): string | null | undefined;
  /** The card's KPI changes as data, for the dashboard's "What changed" summary. */
  changes?(data: Data): (KpiChange | null)[];
  /** Pure card body: one or more ModuleSections. */
  View(props: { data: Data }): ReactNode;
}

/** A module whose Data type isn't known here (the dashboard, the overview and the preview route). */
// Method syntax above keeps DashboardModule<RankData> assignable to this.
export type AnyDashboardModule = DashboardModule<unknown>;

export interface DashboardFixtures<Data> {
  full: Data;
  sparse: Data;
  long: Data;
  more?: Record<string, Data>;
}

// ─── Module frame ─────────────────────────────────────────────────────────────────────────────

const linkFocus = "rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Below md, grows a small link's touch area to about 44px tall with an invisible ::after. */
const touchArea = "relative @max-2xl/main:after:absolute @max-2xl/main:after:-inset-x-1 @max-2xl/main:after:-inset-y-2.5";

/**
 * One module's row of the Overview, shared by every module: no box, the title and what it covers on the
 * left, the figures on the right. Below @3xl/main it stacks. The page draws the hairlines between rows.
 * Pages render this through <ModuleView>.
 */
export function ModuleFrame({
  label,
  href,
  description,
  baseline,
  headingAs: Heading = "h2",
  children,
}: {
  label: string;
  href: string;
  description?: ReactNode;
  /** What the module's changes compare against. Null: nothing earlier. Undefined: it has no changes. */
  baseline?: string | null;
  headingAs?: "h2" | "div";
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid min-w-0 gap-x-8 gap-y-3 py-5 @3xl/main:grid-cols-[13.75rem_minmax(0,1fr)]">
      <header className="min-w-0">
        <Heading id={id} className="text-[15px] font-medium">
          <Link href={href} className={cn("group inline-flex min-h-6 items-center gap-1.5 decoration-tick underline-offset-4 hover:underline", linkFocus, touchArea)}>
            {label}
            <ArrowRight aria-hidden className="size-3.5 text-muted transition-colors duration-[120ms] ease-instrument group-hover:text-fg motion-reduce:transition-none" strokeWidth={1.5} />
          </Link>
        </Heading>
        {(description || baseline !== undefined) && (
          <p className="mt-0.5 text-xs text-pretty text-muted">
            {description}
            {description && baseline !== undefined && " · "}
            {baseline === undefined ? null : baseline ? `vs ${baseline}` : "nothing earlier to compare"}
          </p>
        )}
      </header>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}

/** Renders a module's View inside its frame. */
export function ModuleView<Data>({ module, data, headingAs, note }: { module: DashboardModule<Data>; data: Data; headingAs?: "h2" | "div"; /** Said after the description: a newer check failed, so these numbers are older than that. */ note?: string }) {
  const { View } = module;
  const description = module.describe(data);
  return (
    <ModuleFrame label={module.label} href={module.href} description={note ? <>{description} · {note}</> : description} baseline={module.baseline?.(data)} headingAs={headingAs}>
      <View data={data} />
    </ModuleFrame>
  );
}

/** One group of a module's figures: a KPI row, a chart, a note or a list. */
export function ModuleSection(props: ComponentProps<"div">) {
  return <div {...props} />;
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────────────────────

export type ChangeUnit = "number" | "percent" | "points" | "decimal";

// "5.4%", but "4%" rather than "4.0%".
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Under this on the smaller side, a count's change is the plain difference. */
export const SMALL_BASE = 50;

/**
 * How a count's change is worded: a ratio, or the plain difference when a percentage would overstate
 * it, so 14 → 37 reads "23" rather than "164%". Figures and sentences both ask here, so they can't
 * disagree. Money doesn't: a plain difference would have to name a currency.
 */
export function countChange(now: number, before: number): { value: number; unit: ChangeUnit } {
  if (Math.min(Math.abs(now), Math.abs(before)) < SMALL_BASE) return { value: now - before, unit: "number" };
  return { value: (now - before) / before, unit: "percent" };
}

/** A formatted size in points, worded from what's printed: "1 pt" (1.04 prints as 1), "1.4 pts", "0.05 pts". */
export function inPoints(size: string): string {
  return `${size} ${size === "1" ? "pt" : "pts"}`;
}

/** The unsigned size of a change in its unit: "56%", "5.4%", "1.4 pts", "2.3", "1,204". */
export function magnitude(abs: number, unit: ChangeUnit): string {
  if (unit === "percent") return `${(abs * 100 >= 10 ? whole : oneDecimal).format(abs * 100)}%`;
  if (unit === "points") return inPoints(oneDecimal.format(abs * 100));
  if (unit === "decimal") return oneDecimal.format(abs);
  return formatNumber(abs);
}

/** Formats a signed change: text, plus whether it's good, bad or neutral. */
export function describeChange(change: number, unit: ChangeUnit, goodWhen: "up" | "down" | "neither"): { text: string; tone: "good" | "bad" | "muted" } {
  const mag = magnitude(Math.abs(change), unit);
  // A change that rounds to zero is no change, whatever its sign.
  if (!/[1-9]/.test(mag)) return { text: "No change", tone: "muted" };
  const up = change > 0;
  const tone = goodWhen === "neither" ? "muted" : up === (goodWhen === "up") ? "good" : "bad";
  return { text: `${up ? "+" : "−"}${mag}`, tone };
}

/** One KPI change as data. `from` and `to` are raw values; `format` prints them ("13 → 26"). */
export interface KpiChange {
  label: string;
  from: number;
  to: number;
  unit: ChangeUnit;
  goodWhen: "up" | "down" | "neither";
  format: (n: number) => string;
  /** A ranking position: a summary says "improved 2 places" rather than "down 2". */
  rank?: boolean;
  /** How many impressions, sessions or the like a rate or average is taken over, when that's known. */
  volume?: number | null;
  /** Money: stays a percentage however small, because a plain difference would have to name a currency. */
  money?: boolean;
  /** A count whose figure follows countChange. It stays unit "number", so a start from zero and a few of them still count. */
  count?: boolean;
}

interface CompareOptions {
  unit?: ChangeUnit;
  goodWhen?: "up" | "down" | "neither";
  format?: (n: number) => string;
  rank?: boolean;
  volume?: number | null;
  money?: boolean;
  count?: boolean;
}

/**
 * Builds a KpiChange, or null when either side is missing. Pass the Kpi's own label and goodWhen;
 * `format` defaults to formatNumber. Set `rank` for positions, `count` for a count its Kpi shows
 * through countDeltaFromZero, and `volume` for a rate or average (the smaller of the two periods'
 * impressions or sessions) so "What changed" can skip moves on a handful of visits.
 */
export function compare(
  label: string,
  to: number | null | undefined,
  from: number | null | undefined,
  { unit = "number", goodWhen = "up", format = (n: number) => formatNumber(n), rank, volume, money, count }: CompareOptions = {},
): KpiChange | null {
  if (to == null || from == null || Number.isNaN(to) || Number.isNaN(from)) return null;
  // A relative change from zero has no size to rank, so "What changed" has nothing to say about it.
  if (unit === "percent" && from === 0) return null;
  return { label, from, to, unit, goodWhen, format, rank, volume, money, count };
}

/** The signed raw change of a KpiChange: a ratio for "percent", else to − from. */
export function changeValue(c: Pick<KpiChange, "from" | "to" | "unit">): number {
  return c.unit === "percent" ? (c.to - c.from) / c.from : c.to - c.from;
}

/** A KpiChange in the form to show it, the same one its figure uses: small counts drop to the plain difference. */
export function shownChange(c: Pick<KpiChange, "from" | "to" | "unit" | "money" | "count">): { value: number; unit: ChangeUnit } {
  return c.count || (c.unit === "percent" && !c.money) ? countChange(c.to, c.from) : { value: changeValue(c), unit: c.unit };
}

/**
 * Row of KPIs. Wraps on its own with no fixed column count, on columns that don't stretch to the row's
 * count, so figures line up from one module to the next. Each Kpi spans three rows of this grid (label,
 * value, hint), so a long label that wraps doesn't push its value out of line with its neighbours.
 */
export function KpiRow({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("-mb-4 grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-6", className)} {...props} />;
}

/** One KPI: the app's Figure at its in-card size. See the contract above. */
export function Kpi({ label, value, delta, hint }: { label: string; value: ReactNode; delta?: ChangeDelta | null; hint?: ReactNode }) {
  return <Figure small label={label} value={value} delta={delta} caption={hint} className="row-span-3 mb-4 grid grid-cols-1 grid-rows-subgrid" />;
}

// ─── Notes and lists ──────────────────────────────────────────────────────────────────────────

/** A one-line status inside a card. `live` marks work in progress (a running crawl). */
export function ModuleNote({ live, children }: { live?: boolean; children: ReactNode }) {
  return (
    <p role={live ? "status" : undefined} className="flex items-center gap-2 text-xs text-muted">
      {live && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-secondary" />}
      <span>{children}</span>
    </p>
  );
}

export function ModuleList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn("divide-y divide-line-soft text-sm", className)} {...props} />;
}

export function ModuleListItem({ href, label, meta }: { href: string; label: string; meta?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0">
      <Link href={href} className={cn("min-w-0 flex-[1_1_10rem] truncate hover:text-accent", linkFocus)}>
        {label}
      </Link>
      {meta && <span className="shrink-0 text-xs text-muted">{typeof meta === "string" ? <Digits text={meta} /> : meta}</span>}
    </li>
  );
}

// ─── Dates ────────────────────────────────────────────────────────────────────────────────────

/** "2026-10-07" → "Oct 7", for chart axes. Reads the calendar day without a time zone shift. */
export function chartDay(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─── Dashboard rows (the dashboard and the preview) ──────────────────────────────────────────

/**
 * The quiet list under the cards: modules with no data, and modules whose loader failed.
 * `visible` shows only the first rows and folds the rest behind "N more", so a long setup list
 * doesn't end the page.
 */
export function ModuleRows({ title, visible, children }: { title: string; visible?: number; children: ReactNode }) {
  const id = useId();
  const rows = Children.toArray(children);
  const shown = visible == null ? rows : rows.slice(0, visible);
  const folded = visible == null ? [] : rows.slice(visible);
  const list = "divide-y divide-line-soft text-sm";
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-[15px] font-medium">
        {title} <span className="font-normal text-muted">({rows.length})</span>
      </h2>
      <ul className={cn("mt-2 border-t border-line", list, !folded.length && "border-b")}>{shown}</ul>
      {folded.length > 0 && (
        <details className="group border-y border-line">
          <summary
            className={cn(
              "flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs font-medium text-accent hover:underline [&::-webkit-details-marker]:hidden",
              linkFocus,
            )}
          >
            <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
            <span className="group-open:hidden">{folded.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul className={cn("border-t border-line", list)}>{folded}</ul>
        </details>
      )}
    </section>
  );
}

export function ModuleRow({
  label,
  text,
  href,
  action,
  actionLabel,
  tone,
  extra,
}: {
  label: string;
  text: ReactNode;
  href: string;
  action: string;
  /** Read aloud in place of "<action> <label>", when the action doesn't read with the module's name. */
  actionLabel?: string;
  tone?: "bad";
  /** A second action beside the link, e.g. a retry button. */
  extra?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5">
      <p className="min-w-0 flex-1">
        <span className="font-medium">{label}</span>
        <span className={tone === "bad" ? "text-bad" : "text-muted"}>: {text}</span>
      </p>
      {extra}
      {/* "Set up" alone is ambiguous in a list of links, so the name says which module. */}
      <Link
        href={href}
        aria-label={actionLabel ?? `${action} ${label}`}
        className={cn("inline-flex min-h-6 shrink-0 items-center gap-1 text-xs font-medium text-accent hover:underline", linkFocus, touchArea)}
      >
        {action}
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </li>
  );
}
