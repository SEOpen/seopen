import { notFound } from "next/navigation";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { ModuleRow, ModuleRows, ModuleView, type AnyDashboardModule, type DashboardFixtures } from "@/components/ui/module-card";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Trend } from "@/components/ui/trend";
import { WhatChanged } from "@/components/ui/what-changed";
import { failedCheck } from "@/lib/check-failure";
import * as ai from "@/modules/ai/dashboard.fixtures";
import * as audit from "@/modules/audit/dashboard.fixtures";
import * as backlinks from "@/modules/backlinks/dashboard.fixtures";
import * as domains from "@/modules/domains/dashboard.fixtures";
import * as fixes from "@/modules/fixes/dashboard.fixtures";
import * as google from "@/modules/google/dashboard.fixtures";
import * as ga4 from "@/modules/google/ga4-dashboard.fixtures";
import * as keywords from "@/modules/keywords/dashboard.fixtures";
import * as local from "@/modules/local/dashboard.fixtures";
import * as rank from "@/modules/rank/dashboard.fixtures";
import { buildHeadlines } from "../../dashboard-headlines";
import { withFailures, type ModuleResult } from "../../dashboard-load";
import { DASHBOARD_MODULES } from "../../dashboard-modules";
import { ProjectBoard } from "../../project-board";
import { boardSentence, summarize, worstClause } from "../../project-summary";

export const metadata = { title: "Card preview" };

/** Keyed by module id. */
const FIXTURES: Record<string, DashboardFixtures<unknown>> = {
  google: google.fixtures,
  ga4: ga4.fixtures,
  rank: rank.fixtures,
  local: local.fixtures,
  domains: domains.fixtures,
  audit: audit.fixtures,
  fixes: fixes.fixtures,
  backlinks: backlinks.fixtures,
  ai: ai.fixtures,
  keywords: keywords.fixtures,
};

type State = "full" | "sparse" | "long" | "empty" | "failed" | "slow";

/** Every module's result in one state, with per-module overrides. */
function results(state: State, overrides: Record<string, State> = {}): ModuleResult[] {
  return DASHBOARD_MODULES.map((module): ModuleResult => {
    const s = overrides[module.id] ?? state;
    if (s === "empty") return { module, status: "empty" };
    if (s === "failed" || s === "slow") return { module, status: "failed", slow: s === "slow" };
    return { module, status: "ok", data: FIXTURES[module.id][s] };
  });
}

/** A daily series for the chart-or-number rule: `n` days ending Oct 30, each from `at`. */
const days = (n: number, at: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 31 - n + i)).toISOString().slice(0, 10), value: at(i) }));

/** Every shape the rule can pick. */
const TRENDS: { name: string; props: React.ComponentProps<typeof Trend> }[] = [
  { name: "no points", props: { points: [], label: "Clicks", empty: "Connect Search Console to start." } },
  { name: "one point", props: { points: days(1, () => 86), label: "Site health", format: "score", noun: "crawl" } },
  { name: "three points", props: { points: days(3, (i) => 80 + i * 2), label: "Site health", format: "score", noun: "crawl" } },
  { name: "all equal", props: { points: days(6, () => 86), label: "Site health", format: "score", noun: "crawl" } },
  { name: "few clicks: weekly columns", props: { points: days(28, (i) => i % 5), previous: days(28, (i) => i % 4), label: "Clicks", counts: true } },
  { name: "healthy volume: a line", props: { points: days(28, (i) => 40 + (i % 7) * 6), previous: days(28, (i) => 30 + (i % 7) * 5), label: "Clicks", counts: true } },
  { name: "position", props: { points: days(28, (i) => 14 - i * 0.2), label: "Tracked position", format: "position", position: true, noun: "check" } },
];

/** All projects cards, one per state the page has to handle. */
/** Fixture failures, only ever the words these pages say. */
const failing = (list: ModuleResult[], ...ids: string[]): ModuleResult[] =>
  withFailures(list, new Map(ids.map((id) => [id, failedCheck({ noun: id === "audit" ? "crawl" : id === "ai" ? "run" : "check", at: new Date("2026-11-07T12:00:00Z"), timeZone: "UTC", reason: "None of this check's searches came back.", retry: true, next: { label: "View", href: `/${id}` } })])));

const withReconnect = (list: ModuleResult[]): ModuleResult[] =>
  withFailures(list, new Map([["google", { kind: "reconnect", noun: "sync", at: null, day: null, reason: "Google stopped accepting SEOpen's access, so syncs are paused until you reconnect.", retry: false, next: { label: "Reconnect", href: "/gsc" }, provider: "Google" }]]));

const OVERVIEW_ROWS: { name: string; domain: string; results: ModuleResult[]; locked?: boolean }[] = [
  { name: "Fernhill Coffee", domain: "fernhill.example", results: results("full") },
  { name: "First snapshots", domain: "first-snapshots.example", results: results("sparse") },
  { name: "Search Console only", domain: "gsc-only.example", results: results("empty", { google: "full" }) },
  { name: "A module failing", domain: "failing.example", results: results("full", { rank: "slow", audit: "failed" }) },
  { name: "A failed check over older numbers", domain: "failed-check.example", results: failing(results("full"), "rank", "audit") },
  { name: "Every first check failed", domain: "all-failed.example", results: failing(results("empty"), "rank", "ai", "audit") },
  { name: "Google needs reconnecting", domain: "reconnect.example", results: withReconnect(results("full", { google: "empty" })) },
  { name: "Waiting for first results", domain: "waiting.example", results: results("empty").map((r): ModuleResult => (r.status === "empty" && r.module.id === "rank" ? { ...r, waiting: "8 keywords tracked, waiting for the first check" } : r)) },
  { name: "Nothing set up yet", domain: "nothing-yet.example", results: results("empty") },
  { name: "Read-only after a downgrade", domain: "read-only.example", results: results("full"), locked: true },
  {
    name: "A project name long enough to need truncating at every width, with a long domain too",
    domain: "a-very-long-subdomain.for-a-very-long-domain-name.example.co.uk",
    results: results("long"),
  },
];

/** Project dashboard headlines, one per state the rows and cards have to handle. */
const HEADLINE_STATES: { name: string; results: ModuleResult[]; gscConnected: boolean }[] = [
  { name: "full", results: results("full"), gscConnected: true },
  { name: "first snapshots: nothing earlier to compare", results: results("sparse"), gscConnected: true },
  { name: "long values", results: results("long"), gscConnected: true },
  { name: "only Search Console, the rest not set up", results: results("empty", { google: "full" }), gscConnected: true },
  { name: "Search Console not connected", results: results("full", { google: "empty" }), gscConnected: false },
  { name: "Search Console connected, nothing synced", results: results("full", { google: "empty" }), gscConnected: true },
  { name: "newest check failed, older numbers kept", results: failing(results("full"), "rank", "audit"), gscConnected: true },
  { name: "every first check failed", results: failing(results("empty"), "rank", "ai", "audit"), gscConnected: true },
  { name: "Google needs reconnecting", results: withReconnect(results("full", { google: "empty" })), gscConnected: true },
  { name: "failing and slow loaders", results: results("full", { google: "failed", rank: "slow", ai: "failed", audit: "failed" }), gscConnected: true },
];

/** Dev only: every dashboard card in every fixture state, plus the change summary, rows and empty state. */
export default function CardPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <>
      <PageHeader title="Card preview" description="Dashboard cards rendered from src/modules/*/dashboard.fixtures.ts. Dev only." />
      <div className="flex flex-col gap-12">
        <section aria-label="All projects">
          <h2 className="mb-3 text-sm font-medium">All projects, a card per state</h2>
          <Briefing sentence={boardSentence(OVERVIEW_ROWS.map((r) => ({ name: r.name, summary: summarize(r.results), worstClause: worstClause(r.results) })))} className="mb-5" />
          <ProjectBoard projects={OVERVIEW_ROWS.map((r, i) => ({ id: i + 1, name: r.name, domain: r.domain, locked: !!r.locked, summary: summarize(r.results) }))} />
        </section>
        <section aria-label="Chart or number">
          <h2 className="mb-3 text-sm font-medium">Chart or number: every shape the rule can pick</h2>
          <div className="grid gap-6 @3xl/main:grid-cols-2">
            {TRENDS.map((t) => (
              <figure key={t.name} className="flex min-w-0 flex-col gap-2">
                <figcaption className="text-xs text-muted">{t.name}</figcaption>
                <Trend {...t.props} height={160} />
              </figure>
            ))}
          </div>
        </section>
        <section aria-label="Loading">
          <h2 className="mb-3 text-sm font-medium">Loading</h2>
          <PageSkeleton label="Example" />
        </section>
        <section aria-label="What changed">
          <h2 className="mb-3 text-sm font-medium">Sentence, figures and What changed, per state</h2>
          <div className="flex flex-col gap-10">
            {HEADLINE_STATES.map((h) => {
              const { sentence, rows, also, figures } = buildHeadlines(h.results, { gscConnected: h.gscConnected });
              return (
                <figure key={h.name} className="flex min-w-0 flex-col gap-4">
                  <figcaption className="text-xs text-muted">{h.name}</figcaption>
                  <Briefing sentence={sentence}>
                    {figures.map((f) => (
                      <FigureView key={f.id} data={f} />
                    ))}
                  </Briefing>
                  <div className="max-w-sm">
                    <WhatChanged rows={rows} also={also} />
                  </div>
                </figure>
              );
            })}
          </div>
        </section>
        {DASHBOARD_MODULES.map((m) => (
          <section key={m.id} aria-label={m.label}>
            <h2 className="mb-3 text-sm font-medium">{m.label}</h2>
            <States module={m} fixtures={FIXTURES[m.id]} />
          </section>
        ))}

        <section aria-label="Dashboard rows">
          <h2 className="mb-3 text-sm font-medium">Rows and empty state</h2>
          <ModuleRows title="Couldn't load">
            {DASHBOARD_MODULES.slice(0, 1).map((m) => (
              <ModuleRow key={m.id} label={m.label} text="couldn't load its data (the server log has the error)" href={m.href} action="View" tone="bad" />
            ))}
          </ModuleRows>
          <ModuleRows title="Not set up">
            {DASHBOARD_MODULES.map((m) => (
              <ModuleRow key={m.id} label={m.label} text={m.setup.text} href={m.setup.href} action="Set up" />
            ))}
          </ModuleRows>
          <div className="mt-8">
            <EmptyState
              title="Nothing to show for Example yet"
              description={`Each module adds a card here once it has data. Start by setting up ${DASHBOARD_MODULES[0].label}.`}
              action={<ButtonLink href={DASHBOARD_MODULES[0].setup.href}>Set up {DASHBOARD_MODULES[0].label}</ButtonLink>}
            />
          </div>
        </section>
      </div>
    </>
  );
}

function States({ module, fixtures }: { module: AnyDashboardModule; fixtures: DashboardFixtures<unknown> }) {
  const states: [string, unknown][] = [["full", fixtures.full], ["sparse", fixtures.sparse], ["long", fixtures.long], ...Object.entries(fixtures.more ?? {})];
  return (
    <div className="flex flex-col gap-6">
      {states.map(([state, data]) => (
        <figure key={state} className="flex min-w-0 flex-col gap-1.5">
          <figcaption className="text-xs text-muted">{state}</figcaption>
          <ModuleView module={module} data={data} />
        </figure>
      ))}
    </div>
  );
}
