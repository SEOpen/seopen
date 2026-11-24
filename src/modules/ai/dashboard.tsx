import { and, count, eq } from "drizzle-orm";
import { compare, Kpi, KpiRow, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { deltaBetween } from "@/components/ui/what-changed";
import { db } from "@/db";
import { aiPrompts } from "@/db/schema";
import { isFree } from "@/lib/billing/gates";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { formatDate, formatNumber, formatPct } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { inScope, projectScope, workspaceTimeZone } from "@/lib/workspace";
import { todayIn } from "@/modules/google/windowing";
import { waitingOnFirstRun } from "./brief";
import { getSummary, newestRuns } from "./data";
import { aiFailure } from "./failure";
import type { Visibility } from "./metrics";

type Totals = Pick<Visibility, "total" | "mentioned" | "cited" | "score" | "citedRate">;

export interface AiDashboardData {
  /** When the latest stored answer's run happened, ISO string. */
  lastRunAt: string;
  /** The workspace's zone, which `lastRunAt` reads in. */
  timeZone: string;
  /** Latest answer per prompt × platform across all runs. */
  current: Totals;
  /** The same without the latest run, or null when there is only one run or the newest run got no answer back. */
  previous: Totals | null;
  /** Prompt × platform pairs whose newest answer failed. An answer that failed isn't one that didn't name you, so it's said beside `current`, not in it. */
  failed: number;
  /** The newest run got no answer back, so `previous` is null though earlier runs exist: these are the run before's numbers, with no change reported. */
  failedRun?: boolean;
  /** How many engines answered in the latest answers. */
  engines: number;
  /** Cited answers after each run, oldest first. `date` is the run's day in the workspace's zone. */
  trend: { date: string; cited: number }[];
  /** Whether the numbers leave branded prompts out (the default) or count them; null when there are none. */
  branded: "left out" | "counted" | null;
}

const totals = (v: Visibility): Totals => ({ total: v.total, mentioned: v.mentioned, cited: v.cited, score: v.score, citedRate: v.citedRate });

/** AI visibility from stored answers, against the state before the latest run. Database reads only. */
async function load(project: Project): Promise<AiDashboardData | null> {
  const s = await getSummary(project);
  if (!s) return null;
  const timeZone = await workspaceTimeZone(project);
  return {
    lastRunAt: s.lastRunAt.toISOString(),
    timeZone,
    current: totals(s.current),
    previous: s.previous ? totals(s.previous) : null,
    failed: s.failed,
    ...(s.failedRun ? { failedRun: true } : {}),
    engines: s.engines,
    trend: s.trend.map((p) => ({ date: todayIn(timeZone, new Date(p.at)), cited: p.cited })),
    branded: s.branded,
  };
}

function describe(d: AiDashboardData) {
  const latest = `Latest answers ${formatDate(d.lastRunAt, d.timeZone)}`;
  return d.branded ? `${latest} · branded prompts ${d.branded}` : latest;
}

function changes(d: AiDashboardData) {
  // One decimal, like the change: "▼ 1.7 pts" over "6% → 5%" looks like a mistake.
  return [compare("AI visibility", d.current.score, d.previous?.score, { unit: "points", format: (n) => formatPct(n) })];
}

function View({ data: d }: { data: AiDashboardData }) {
  const { current: cur, previous: prev } = d;
  return (
    <ModuleSection>
      <KpiRow>
        <Kpi label="AI visibility" value={formatPct(cur.score)} delta={deltaBetween(cur.score, prev?.score, "points")} />
        <Kpi label="Answers naming you" value={`${formatNumber(cur.mentioned)} of ${formatNumber(cur.total)}`} hint={d.failed ? `${formatNumber(d.failed)} failed` : undefined} />
      </KpiRow>
    </ModuleSection>
  );
}

/** Prompts added but not asked yet. Free asks none. */
async function waiting(project: Project): Promise<string | null> {
  const [[{ n }], ws] = await Promise.all([
    db
      .select({ n: count() })
      .from(aiPrompts)
      .where(and(inScope(aiPrompts, projectScope(project)), eq(aiPrompts.active, true))),
    loadBillingWorkspace(project.workspaceId),
  ]);
  return n ? waitingOnFirstRun(n, isFree(ws)) : null;
}

/** Projects whose newest run failed, read together. Database reads only. */
async function failures(projects: Project[], timeZone: string) {
  const runs = await newestRuns(projects[0].workspaceId, projects.map((p) => p.id));
  return new Map(runs.flatMap((run) => {
    const failure = aiFailure(run, timeZone);
    return failure ? [[run.projectId, failure] as const] : [];
  }));
}

export const dashboard: DashboardModule<AiDashboardData> = {
  id: "ai",
  label: "AI visibility",
  href: "/ai",
  setup: { text: "no tracked prompts yet", href: "/ai/prompts" },
  load,
  waiting,
  failures,
  describe,
  // After a run that got nothing back there was a run before, so not "nothing earlier": the failure says why there's no change.
  baseline: (d) => (d.previous ? "previous run" : d.failedRun ? undefined : null),
  changes,
  View,
};
