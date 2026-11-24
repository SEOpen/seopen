import { NoProject } from "@/components/require-project";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { keywordUnits, showsDollarCosts } from "@/lib/billing/gates";
import { isStalePosting, POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { plainRankFailure } from "@/lib/dataforseo/failure-copy";
import { formatUsd, timeZoneLabel } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { weeklyJobDays, zonedJobTime } from "@/lib/schedule";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { ActionForm } from "@/components/ui/action-form";
import { setKeywordsActive, updateSettings } from "@/modules/rank/actions";
import { runDay, runProgress, withoutEmptyColumns } from "@/modules/rank/brief";
import { CheckNowButtons, lastCheckedLabel, RankTabs, RunStatus } from "@/modules/rank/components/chrome";
import { DAILY_DEPTHS } from "@/modules/rank/depth-hint";
import { estimateCheckCost, MAX_LOOKS } from "@/modules/rank/metrics";
import { listRuns, loadTracker } from "@/modules/rank/queries";

export const metadata = { title: "Rankings settings" };

/** How many keywords of the plan's limit one keyword uses at a daily depth. */
const unitsLabel = (depth: number) => {
  const u = keywordUnits(depth);
  return u === 1 ? "counts once" : `counts as ${u}`;
};

export default async function RankSettingsPage() {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const [ws, timeZone, state, runs] = await Promise.all([currentWorkspace(), currentTimeZone(), loadTracker(projectScope(project)), listRuns(projectScope(project))]);
  // Customers' checks are covered by the plan; depth matters to them through keyword units.
  const showCost = showsDollarCosts(ws);
  const s = state.settings;
  const active = state.keywords.filter((k) => k.active).length;
  const inactive = state.keywords.filter((k) => !k.active);
  const daysPerMonth = 30.4;
  const sweeps = s.sweepWeekday >= 0 ? daysPerMonth / 7 : 0;
  const monthly =
    estimateCheckCost(active, s.dailyDepth) * (daysPerMonth - sweeps) + estimateCheckCost(active, s.sweepDepth, true) * sweeps;

  // The cost is SEOpen's own, so a customer's page never receives it: not in a column, not in the rows.
  const runRows = runs.map((r) => ({
    id: r.id,
    date: runDay(r.createdAt, timeZone),
    place: state.places.find((p) => p.code === r.locationCode)?.name ?? "",
    kind: r.kind === "sweep" ? "weekly" : r.kind,
    depth: r.aiOverview ? `Top ${r.depth} + AI Overviews` : `Top ${r.depth}`,
    // Past the hour nothing is posting any more, whether or not a later check has closed the row: the callout above says the same.
    status: isStalePosting(r) || r.error === POSTING_NEVER_FINISHED ? "didn't start" : r.status,
    progress: runProgress(r),
    ...(showCost ? { cost: r.costUsd } : {}),
    started: r.createdAt,
    finished: r.finishedAt,
    error: showCost ? (r.error ?? "") : plainRankFailure(r.error),
  }));
  const runColumns: ColumnSpec[] = [
    { key: "date", label: "Date", format: "date" },
    { key: "place", label: "Searched from" },
    { key: "kind", label: "Kind", format: "badge" },
    { key: "depth", label: "Depth" },
    { key: "status", label: "Status", format: "badge" },
    { key: "progress", label: "Results" },
    ...(showCost ? [{ key: "cost", label: "Cost", format: "usd" } as const] : []),
    { key: "started", label: "Started", format: "datetime" },
    { key: "finished", label: "Finished", format: "datetime" },
    { key: "error", label: "Error" },
  ];

  return (
    <>
      <PageHeader
        title="Rankings"
        description={<>When and how deep your keywords are checked, and every check so far · {lastCheckedLabel(state, timeZone)}</>}
        actions={<CheckNowButtons project={project} state={state} />}
      />
      <RankTabs hasResults={state.dates.length > 0} />
      <RunStatus state={state} resultsBelow={false} />

      <Card>
        <CardHeader title="Schedule" description={`Checks run at ${zonedJobTime("06:00", timeZone)}. Charts file results under the UTC date, so a check you start yourself can land on the day before or after.`} />
        <CardBody>
          <ActionForm action={updateSettings.bind(null, project.id)} className="flex flex-col gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={s.enabled} />
              Run scheduled checks
            </label>
            <div className="grid gap-3 @3xl/main:grid-cols-3">
              <Label>
                Daily check depth
                <Select name="dailyDepth" defaultValue={String(s.dailyDepth)}>
                  {DAILY_DEPTHS.map((d) => (
                    <option key={d} value={d}>
                      Top {d} ({showCost ? `${formatUsd(estimateCheckCost(1, d), 4)} per keyword` : unitsLabel(d)})
                    </option>
                  ))}
                </Select>
              </Label>
              <Label>
                Weekly check day
                <Select name="sweepWeekday" defaultValue={String(s.sweepWeekday)}>
                  {weeklyJobDays("06:00", timeZone).map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                  <option value={-1}>No weekly check</option>
                </Select>
              </Label>
              <Label>
                Weekly check depth (with AI Overviews)
                <Select name="sweepDepth" defaultValue={String(s.sweepDepth)}>
                  {[50, 100].map((d) => (
                    <option key={d} value={d}>
                      {showCost ? `Top ${d} (${formatUsd(estimateCheckCost(1, d, true), 4)} per keyword)` : `Top ${d}`}
                    </option>
                  ))}
                </Select>
              </Label>
            </div>
            <p className="max-w-[69ch] text-xs text-muted">
              {showCost ? (
                <>
                  {active} active keywords ≈ <strong className="text-fg">{formatUsd(monthly)}</strong> per month at these settings, up to{" "}
                  <strong className="text-fg">{formatUsd(monthly * MAX_LOOKS)}</strong> if every keyword needs both rechecks. Prices above are per look.
                </>
              ) : (
                <>
                  {active} active keywords count as <strong className="text-fg">{active * keywordUnits(s.dailyDepth)}</strong> toward your plan&apos;s keyword limit when the daily check looks at the top {s.dailyDepth}. The weekly check is included.
                </>
              )}
            </p>
            <Button type="submit" className="self-start">
              Save
            </Button>
          </ActionForm>
        </CardBody>
      </Card>

      {inactive.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Paused keywords" description="Kept with their history but not checked." />
          <CardBody>
            <ActionForm action={setKeywordsActive.bind(null, project.id, inactive.map((k) => k.id), true)} className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{inactive.map((k) => k.keyword).join(", ")}</span>
              <Button size="sm" variant="secondary" type="submit">
                Resume all
              </Button>
            </ActionForm>
          </CardBody>
        </Card>
      )}

      <Section title="Checks" description={`The last 30, newest first. Times are in ${timeZoneLabel(timeZone)}.`}>
        <DataTable filename="rank-runs" searchable={false} pageSize={15} rows={runRows} columns={withoutEmptyColumns(runColumns, runRows, ["place", "error"])} />
      </Section>
    </>
  );
}
