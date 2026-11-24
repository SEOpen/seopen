import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, OctagonAlert } from "lucide-react";
import Link from "next/link";
import { accountsFigure, overviewSentence } from "@/components/admin/brief";
import { DailyColumns } from "@/components/admin/daily-columns";
import { Briefing } from "@/components/ui/briefing";
import { DataTable } from "@/components/ui/data-table";
import { Figure, FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { requireAdmin } from "@/lib/admin/access";
import { platformHealth } from "@/lib/admin/health";
import { OVERVIEW_DAYS, accountCount, dailyActivity } from "@/lib/admin/overview";
import { platformCapUsd } from "@/lib/billing/spend";
import { platformMonthUsage } from "@/lib/billing/usage";
import { formatNumber, formatPct, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { admin } from "@/plan-policy/admin";

export const metadata = { title: "Overview · Admin" };

/** Where the meter turns to a warning, as a share of the platform cap. */
const METER_WARN = 0.8;

const quietLink = "rounded-sm text-sm text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * Admin → Overview: this copy at a glance. A sentence and the headline figures; the 30-day measures as
 * small multiples on their own axes (never one chart with two scales); spend as a meter against the
 * platform cap; and the Health counts, each with an icon and a label. The plan policy adds its own
 * figures, daily counts and a funnel of ranked bars (`@/plan-policy/admin`).
 */
export default async function AdminOverviewPage() {
  await requireAdmin();
  const [accounts, days, usage, cap, health, extra] = await Promise.all([accountCount(), dailyActivity(), platformMonthUsage(), platformCapUsd(), platformHealth(), admin.overview(OVERVIEW_DAYS)]);

  const funnel = extra.funnel?.steps ?? [];
  const first = funnel[0]?.n ?? 0;
  const top = Math.max(1, ...funnel.map((s) => s.n));

  const healthRows = [
    { label: "Worker", n: health.worker.length, severe: true },
    { label: "DataForSEO balance", n: health.balance.length, severe: true },
    { label: "Failed jobs (7 days)", n: health.failed.reduce((n, f) => n + f.n, 0), severe: true },
    { label: "Syncs with a problem", n: health.syncs.length, severe: false },
    { label: "Broken connections", n: health.connections.length, severe: false },
    { label: "Paused jobs", n: health.paused.length, severe: false },
    // One workspace can be both, and Health lists it once.
    { label: "Spend alerts or near a ceiling", n: new Set([...health.alerts, ...health.near].map((w) => w.workspaceId)).size, severe: false },
    { label: health.stopped.label, n: health.stopped.rows.length, severe: true },
  ];

  // The plan's daily counts first, then core's: one chart, one column and one total each.
  const measures = [
    ...extra.daily.map((m) => ({ key: m.key, label: m.label, usd: false, read: (d: (typeof days)[number]) => m.byDate[d.date] ?? 0 })),
    { key: "accounts", label: "New accounts", usd: false, read: (d: (typeof days)[number]) => d.accounts },
    { key: "spendUsd", label: "DataForSEO spend", usd: true, read: (d: (typeof days)[number]) => d.spendUsd },
  ];
  const rows = days.map((d) => ({ ...Object.fromEntries(measures.map((m) => [m.key, m.read(d)])), date: d.date }));

  return (
    <>
      <PageHeader title="Overview" description={extra.description} />

      <Briefing sentence={overviewSentence(days, healthRows.reduce((n, r) => n + r.n, 0), extra.daily)}>
        {[accountsFigure(accounts, days), ...extra.figures].map((figure) => (
          <FigureView key={figure.id} data={figure} />
        ))}
      </Briefing>

      <Section title={`Last ${OVERVIEW_DAYS} days`} description="One measure per chart, each on its own scale. Days are UTC.">
        <div className={cn("grid gap-x-8 gap-y-6", measures.length > 2 ? "@2xl/main:grid-cols-3" : "@2xl/main:grid-cols-2")}>
          {measures.map((m) => {
            const data = days.map((d) => ({ date: d.date, value: m.read(d) }));
            const total = data.reduce((n, p) => n + p.value, 0);
            return (
              <Multiple key={m.key} title={m.label} total={m.usd ? formatUsd(total, 2) : formatNumber(total)}>
                <DailyColumns data={data} label={m.label} format={m.usd ? "usd" : undefined} />
              </Multiple>
            );
          })}
        </div>
        <details className="group mt-1">
          {/* TimeChart's toggle, as a disclosure: the charts stay on screen, so it says Hide rather than Show as chart. */}
          <summary className="ml-auto flex min-h-6 w-fit cursor-pointer list-none items-center rounded-sm text-xs text-muted underline-offset-3 hover:text-fg hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show as table</span>
            <span className="hidden group-open:inline">Hide table</span>
          </summary>
          <div className="mt-2 text-sm">
            <DataTable
              searchable={false}
              filename="daily-activity"
              columns={[{ key: "date", label: "Day", format: "date" }, ...measures.map((m) => ({ key: m.key, label: m.label, format: m.usd ? ("usd" as const) : ("number" as const) }))]}
              rows={rows}
              initialSort={{ key: "date", desc: true }}
            />
          </div>
        </details>
      </Section>

      <div className="grid gap-x-8 @3xl/main:grid-cols-2">
        <SpendMeter spent={usage.spentUsd} reserved={usage.reservedUsd} cap={cap} />

        {extra.funnel && (
          <Section title={extra.funnel.title} description={extra.funnel.description}>
            <ol className="flex flex-col gap-3">
              {funnel.map((s, i) => (
                <li key={s.label}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span>{s.label}</span>
                    <span className="text-muted">
                      <span className="data text-fg">{formatNumber(s.n)}</span>
                      {first > 0 && i > 0 && <span className="data"> · {formatPct(s.n / first, 0)}</span>}
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-sm bg-surface-2">
                    <div className="h-full rounded-sm bg-secondary" style={{ width: `${(s.n / top) * 100}%`, minWidth: s.n > 0 ? 4 : 0 }} />
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>

      <Section
        title="Health"
        description="Counts from the Health page, across every workspace."
        actions={
          <Link href="/admin/health" className={quietLink}>
            Open Health
          </Link>
        }
      >
        <ul className="divide-y divide-line-soft border-y border-line-soft">
          {healthRows.map((r) => {
            const Icon = r.n === 0 ? CheckCircle2 : r.severe ? OctagonAlert : AlertTriangle;
            return (
              <li key={r.label} className="flex items-center gap-3 py-2.5 text-sm">
                <Icon aria-hidden strokeWidth={1.5} className={cn("size-4 shrink-0", r.n === 0 ? "text-secondary" : r.severe ? "text-bad" : "text-warn")} />
                <span className="flex-1">{r.label}</span>
                <span className="data">{r.n === 0 ? "None" : formatNumber(r.n)}</span>
              </li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}

function Multiple({ title, total, children }: { title: string; total: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="data text-muted">{total}</span>
      </div>
      {children}
    </div>
  );
}

/** This month's DataForSEO spend against the platform cap: a warning at 80%, a stop at 100%. */
function SpendMeter({ spent, reserved, cap }: { spent: number; reserved: number; cap: number }) {
  const share = spent / cap;
  const state = share >= 1 ? "over" : share >= METER_WARN ? "near" : "ok";
  return (
    <Section
      title="DataForSEO this month"
      description="Spend against the platform cap. Calls stop at the cap."
      actions={
        <Link href="/admin/spend" className={quietLink}>
          Open Spend
        </Link>
      }
    >
      <Figure label="Spent" value={formatUsd(spent, 2)} caption={`of ${formatUsd(cap, 0)} platform cap`} />
      <div
        role="meter"
        aria-label="DataForSEO spend against the platform cap"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.round(spent * 100) / 100}
        aria-valuetext={`${formatUsd(spent, 2)} of ${formatUsd(cap, 0)}, ${formatPct(share, 0)}`}
        className="relative mt-3 h-2 overflow-hidden rounded-sm bg-surface-2"
      >
        <div className={cn("h-full", state === "over" ? "bg-bad" : state === "near" ? "bg-warn-mark" : "bg-secondary")} style={{ width: `${Math.min(100, share * 100)}%` }} />
        <div aria-hidden className="absolute top-0 h-full w-0.5 bg-bg" style={{ left: `${METER_WARN * 100}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className={cn("flex items-center gap-1.5", state === "over" ? "text-bad" : state === "near" ? "text-warn" : "text-muted")}>
          {state === "over" ? <OctagonAlert aria-hidden strokeWidth={1.5} className="size-4" /> : state === "near" ? <AlertTriangle aria-hidden strokeWidth={1.5} className="size-4" /> : null}
          {state === "over" ? "At the cap: paid calls have stopped" : state === "near" ? "Over 80% of the cap" : `${formatPct(share, 0)} used`}
        </span>
        <span className="data text-muted">{formatUsd(Math.max(0, cap - spent), 2)} left</span>
      </div>
      {reserved > 0 && <p className="mt-2 text-xs text-muted">{formatUsd(reserved, 2)} more is held for calls running now.</p>}
    </Section>
  );
}
