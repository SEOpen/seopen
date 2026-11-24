import { columnsWithData, healthFigures, healthSentence } from "@/components/admin/brief";
import { Briefing } from "@/components/ui/briefing";
import { Callout } from "@/components/ui/callout";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { NEAR_CEILING_SHARE, platformHealth } from "@/lib/admin/health";
import { STALE_SYNC_DAYS } from "@/lib/admin/sync-problem";
import { jobLabel } from "@/lib/billing/pauses";
import { DATA_STOPPED_DAYS } from "@/lib/check-failure";
import { BALANCE_FLOOR_USD, PAYMENT_PROBLEM_HOURS } from "@/lib/dataforseo/balance";
import { formatUsd } from "@/lib/format";
import { HEARTBEAT_EVERY_MINUTES } from "@/lib/jobs/heartbeat";
import { WATCH_EVERY_MINUTES, WORKER_STALE_MINUTES } from "@/lib/jobs/worker-watch";
import { requireAdmin } from "@/lib/admin/access";
import { rules } from "@/plan-policy/rules";

export const metadata = { title: "Health · Admin" };

const workspaceCol: ColumnSpec = { key: "workspace", label: "Workspace", format: "link", href: "/admin/workspaces/{workspaceId}" };

interface ProblemListProps {
  title: string;
  description: string;
  rows: Record<string, unknown>[];
  columns: ColumnSpec[];
  filename: string;
}

/** One problem list. Empty lists say so in a line, so the page reads as a checklist. */
function ProblemList({ title, description, rows, columns, filename }: ProblemListProps) {
  return (
    <Section title={`${title} (${rows.length})`} description={description}>
      {rows.length === 0 ? <p className="text-sm text-secondary">Nothing here.</p> : <DataTable searchable={false} filename={filename} columns={columnsWithData(columns, rows)} rows={rows} />}
    </Section>
  );
}

/**
 * The owner's morning check across every workspace: the worker's heartbeat, the DataForSEO balance, failed jobs, syncs
 * that stopped, broken connections, paused jobs, spend over an alert or near a ceiling, and workspaces that can't spend. Lists
 * with something in them come first, so the first table is above the fold. A worker problem is also a red callout
 * above everything: while it lasts nothing else on the page moves.
 */
export default async function AdminHealthPage() {
  await requireAdmin();
  const h = await platformHealth();
  const spend = [
    ...h.alerts.map((a) => ({ workspaceId: a.workspaceId, workspace: a.name, plan: a.plan, detail: a.reasons.join("; ") })),
    ...h.near
      .filter((n) => !h.alerts.some((a) => a.workspaceId === n.workspaceId))
      .map((n) => ({ workspaceId: n.workspaceId, workspace: n.workspace, plan: n.plan, detail: `${formatUsd(n.spentUsd, 2)} of its ${formatUsd(n.ceilingUsd, 2)} ceiling this month` })),
  ];
  const counts = {
    worker: h.worker.length,
    balance: h.balance.length,
    failed: h.failed.reduce((n, f) => n + f.n, 0),
    syncs: h.syncs.length,
    connections: h.connections.length,
    paused: h.paused.length,
    spend: spend.length,
    billing: h.stopped.rows.length,
    billingNoun: h.stopped.noun,
    moneyLabel: h.stopped.figure,
  };

  const lists: ProblemListProps[] = [
    {
      title: "Worker",
      description: `The background worker writes a heartbeat every ${HEARTBEAT_EVERY_MINUTES} minutes. None for ${WORKER_STALE_MINUTES} minutes means it's down; a scheduled check runs every ${WATCH_EVERY_MINUTES} minutes and emails the owner once per outage, and again when it's back.`,
      filename: "worker",
      rows: h.worker.map((w) => ({ ...w })),
      columns: [
        { key: "problem", label: "Problem", format: "badge" },
        { key: "detail", label: "Detail" },
        { key: "at", label: "Since", format: "datetime" },
      ],
    },
    {
      title: "DataForSEO balance",
      description: `The prepaid balance every paid call spends from, across all workspaces. Low when the daily 08:00 check reads under a week of calls (${formatUsd(BALANCE_FLOOR_USD, 0)} at least); a 402 shows for ${PAYMENT_PROBLEM_HOURS} hours unless a later check finds enough, and a 40203 (DataForSEO's daily spend limit) until 00:00 UTC. Top up, or change the limit under Settings, at app.dataforseo.com.`,
      filename: "dataforseo-balance",
      rows: h.balance.map((b) => ({ ...b })),
      columns: [
        { key: "problem", label: "Problem", format: "badge" },
        { key: "detail", label: "Detail" },
        { key: "at", label: "When", format: "datetime" },
      ],
    },
    {
      title: "Failed jobs",
      description: "Background jobs that failed in the last 7 days, by queue and workspace, with the latest error.",
      filename: "failed-jobs",
      rows: h.failed.map((f) => ({ ...f, workspace: f.workspace ?? "Platform", workspaceId: f.workspaceId ?? "" })),
      columns: [
        { key: "name", label: "Job" },
        workspaceCol,
        { key: "n", label: "Failures", format: "number" },
        { key: "error", label: "Latest error" },
        { key: "last", label: "Last", format: "datetime" },
      ],
    },
    {
      title: "Syncs",
      description: `Search Console, GA4, PostHog, Plausible and Umami syncs that errored, need a reconnect, hit a quota, haven't succeeded for ${STALE_SYNC_DAYS} days, or sync while no Analytics data has arrived for ${DATA_STOPPED_DAYS} days.`,
      filename: "sync-problems",
      rows: h.syncs.map((s) => ({ ...s })),
      columns: [
        workspaceCol,
        { key: "domain", label: "Project" },
        { key: "sourceLabel", label: "Source" },
        { key: "kind", label: "Problem", format: "badge" },
        { key: "detail", label: "Detail" },
        { key: "lastSuccessAt", label: "Last success", format: "datetime" },
      ],
    },
    {
      title: "Connections",
      description: "Google, PostHog, Plausible and Umami accounts that aren't active or failed their last token refresh.",
      filename: "connection-problems",
      rows: h.connections.map((c) => ({ ...c })),
      columns: [workspaceCol, { key: "service", label: "Service" }, { key: "account", label: "Account" }, { key: "status", label: "Status", format: "badge" }, { key: "error", label: "Error" }],
    },
    {
      title: "Paused jobs",
      description: rules.hasPlans
        ? "Scheduled jobs stopped by a plan limit. An upgrade or the next passing run clears them."
        : "Scheduled jobs stopped by a monthly cap. A higher cap, a new month or the next passing run clears them.",
      filename: "paused-jobs",
      rows: h.paused.map((p) => ({ ...p, job: jobLabel(p.job) })),
      columns: [
        workspaceCol,
        { key: "domain", label: "Project" },
        { key: "job", label: "Job" },
        { key: "reason", label: "Reason", format: "badge" },
        { key: "message", label: "Message" },
        { key: "pausedAt", label: "Paused", format: "datetime" },
      ],
    },
    {
      title: "Spend",
      description: `Workspaces over the daily or weekly spend alert, or at ${Math.round(NEAR_CEILING_SHARE * 100)}% of their ceiling this month.`,
      filename: "spend-problems",
      rows: spend,
      columns: [workspaceCol, { key: "plan", label: "Plan", format: "badge" }, { key: "detail", label: "Why" }],
    },
    {
      title: h.stopped.title,
      description: h.stopped.description,
      filename: h.stopped.filename,
      rows: h.stopped.rows.map((b) => ({ ...b })),
      columns: [workspaceCol, { key: "plan", label: "Plan", format: "badge" }, { key: "problem", label: "Problem" }],
    },
  ];

  return (
    <>
      <PageHeader title="Health" description="What needs a look across every workspace, read live. Each row links to its workspace." />
      {h.worker.map((w) => (
        <Callout key={w.problem} tone="bad" role="alert" title={w.problem === "Watch not running" ? "The worker watch isn't running" : "The worker is down"}>
          {w.detail}
        </Callout>
      ))}
      <Briefing sentence={healthSentence(counts)}>
        {healthFigures(counts).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>

      {[...lists.filter((l) => l.rows.length), ...lists.filter((l) => !l.rows.length)].map((l) => (
        <ProblemList key={l.filename} {...l} />
      ))}
    </>
  );
}
