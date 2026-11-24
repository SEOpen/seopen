import { and, asc, eq, gte, sql } from "drizzle-orm";
import { workspacesSentence } from "@/components/admin/brief";
import { WorkspacesTable, type WorkspaceRow } from "@/components/admin/workspaces-table";
import { Briefing } from "@/components/ui/briefing";
import { Figure } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { db } from "@/db";
import { apiLedger, workspaces, workspaceUsage } from "@/db/schema";
import { DAILY_ALERT_USD, findSpendAlerts } from "@/lib/billing/alerts";
import { creditsUsed, limitsFor } from "@/lib/billing/gates";
import { admin } from "@/plan-policy/admin";
import { rules } from "@/plan-policy/rules";
import { platformCapUsd } from "@/lib/billing/spend";
import { platformMonthUsage } from "@/lib/billing/usage";
import { formatNumber, formatShortDate, formatUsd } from "@/lib/format";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";
import { requireAdmin } from "@/lib/admin/access";
import { currentTimeZone } from "@/lib/workspace/current";

export const metadata = { title: "Workspaces · Admin" };

/**
 * The owner's console: every workspace's plan and spend this month, what the plan policy adds
 * (`@/plan-policy/admin`), and a Suspend switch. Only admins see it; anyone else gets a 404.
 */
export default async function AdminPage() {
  await requireAdmin();
  const timeZone = await currentTimeZone();
  const date = (d: Date | null) => formatShortDate(d, timeZone);

  const month = sql`date_trunc('month', now())::date`;
  const [rows, today, platform, cap, alerts] = await Promise.all([
    db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        plan: workspaces.plan,
        status: workspaces.status,
        limits: workspaces.limits,
        // limitsFor reads it: a plan that ended falls back.
        grantEndsAt: workspaces.grantEndsAt,
        createdAt: workspaces.createdAt,
        spentUsd: sql<number>`coalesce(${workspaceUsage.spentUsd}, 0)::float`,
        researchUsd: sql<number>`coalesce(${workspaceUsage.researchUsd}, 0)::float`,
      })
      .from(workspaces)
      .leftJoin(workspaceUsage, and(eq(workspaceUsage.workspaceId, workspaces.id), eq(workspaceUsage.month, month)))
      .orderBy(asc(workspaces.id)),
    db
      .select({ workspaceId: apiLedger.workspaceId, usd: sql<number>`sum(${apiLedger.chargedUsd})::float` })
      .from(apiLedger)
      .where(gte(apiLedger.createdAt, sql`now() - interval '1 day'`))
      .groupBy(apiLedger.workspaceId),
    platformMonthUsage(),
    platformCapUsd(),
    findSpendAlerts(),
  ]);
  const extra = await admin.workspaces(rows, timeZone);
  const todayBy = new Map(today.map((t) => [t.workspaceId, t.usd]));
  const alerted = new Set(alerts.map((a) => a.workspaceId));

  const tableRows: WorkspaceRow[] = rows.map((r) => {
    const limits = limitsFor(r);
    const more = extra.byId.get(r.id);
    return {
      id: r.id,
      name: r.name,
      since: date(r.createdAt),
      plan: rules.planLabel(r.plan),
      subscriptionStatus: more?.status ?? null,
      suspended: r.status === "suspended",
      spentUsd: r.spentUsd,
      ceilingUsd: Number.isFinite(limits.ceilingUsd) ? limits.ceilingUsd : null,
      overAlert: alerted.has(r.id),
      last24Usd: todayBy.get(r.id) ?? 0,
      credits: creditsUsed(r.researchUsd),
      creditLimit: Number.isFinite(limits.researchCredits) ? limits.researchCredits : null,
      claims: more ? more.claims : null,
      note: more?.note ?? "",
      canSuspend: r.id !== OWNER_WORKSPACE_ID,
    };
  });

  return (
    <>
      <PageHeader title="Workspaces" description="Every workspace's plan and spend this month, read live. Suspending stops paid calls and jobs; data stays." />
      <Briefing
        sentence={workspacesSentence({ total: rows.length, kinds: extra.kinds, suspended: rows.filter((r) => r.status === "suspended").length, alerts: alerts.length, spentUsd: platform.spentUsd, capUsd: cap })}
      >
        <Figure label="DataForSEO this month" value={formatUsd(platform.spentUsd, 2)} caption={`of ${formatUsd(cap, 0)} platform cap`} />
        {extra.figures.map((f) => (
          <Figure key={f.label} label={f.label} value={f.value} caption={f.caption} />
        ))}
        <Figure label="Spend alerts" value={formatNumber(alerts.length)} caption={`over ${formatUsd(DAILY_ALERT_USD, 0)}/day or half the ceiling/week`} />
      </Briefing>

      <Section title="All workspaces">
        <WorkspacesTable rows={tableRows} />
      </Section>
    </>
  );
}
