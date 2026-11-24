import { and, desc, eq, gte, sql } from "drizzle-orm";
import { setOwnerCap, setPlatformCap } from "@/app/actions/billing";
import { ActionForm } from "@/components/ui/action-form";
import { OWNER_CAP_MAX, PLATFORM_CAP_MAX } from "@/lib/billing/caps";
import { spendFigures, spendSentence } from "@/components/admin/brief";
import { Briefing } from "@/components/ui/briefing";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { FigureView } from "@/components/ui/figure";
import { Input, Label } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { db } from "@/db";
import { apiLedger } from "@/db/schema";
import { dailyActivity } from "@/lib/admin/overview";
import { platformCapUsd } from "@/lib/billing/spend";
import { platformMonthUsage } from "@/lib/billing/usage";
import { monthlyCapUsd, monthToDateSpendUsd } from "@/lib/dataforseo/client";
import { formatUsd } from "@/lib/format";
import { requireAdmin } from "@/lib/admin/access";
import { isUndefinedTable } from "@/modules/rank/db-errors";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";

export const metadata = { title: "Spend · Admin" };

/** The owner workspace's jobs in the last 7 days, plus the platform jobs that belong to no workspace (cron fan-outs and the pollers). */
async function jobStats(workspaceId: number) {
  try {
    const rows = await db.execute<{ name: string; state: string; n: number; last: string | null }>(sql`
      select name, state, count(*)::int as n, max(coalesce(completed_on, started_on, created_on))::text as last
      from pgboss.job
      where created_on > now() - interval '7 days'
        and (data->>'workspaceId' = ${String(workspaceId)} or data->>'workspaceId' is null)
      group by name, state
      order by name, state`);
    return [...rows];
  } catch (e) {
    // pgboss.job exists only once the worker has started against this database. Any other failure surfaces.
    if (isUndefinedTable(e)) return [];
    throw e;
  }
}

/**
 * The owner's DataForSEO spend: this month's spend by module, the ledger and the background jobs, then
 * the platform cap over every workspace and the owner workspace's own cap. Customers never see dollars;
 * their usage is in credits and plan limits on Billing.
 */
export default async function AdminSpendPage() {
  await requireAdmin();
  const ownerId = OWNER_WORKSPACE_ID;
  const monthStart = sql`date_trunc('month', now())`;
  const mine = eq(apiLedger.workspaceId, ownerId);
  const [spent, cap, byModule, recent, jobs, platformCap, platform, days] = await Promise.all([
    monthToDateSpendUsd(ownerId),
    monthlyCapUsd(ownerId),
    db
      .select({ module: apiLedger.module, cost: sql<number>`sum(${apiLedger.chargedUsd})::float`, calls: sql<number>`count(*)::int` })
      .from(apiLedger)
      .where(and(mine, gte(apiLedger.createdAt, monthStart)))
      .groupBy(apiLedger.module),
    db.select().from(apiLedger).where(mine).orderBy(desc(apiLedger.createdAt)).limit(200),
    jobStats(ownerId),
    platformCapUsd(),
    platformMonthUsage(),
    dailyActivity(14),
  ]);

  return (
    <>
      <PageHeader
        title="Spend"
        description="DataForSEO spend, read live from the ledger: the owner workspace's calls this month, the background jobs and the caps."
        actions={
          <a href="#caps" className="rounded-sm text-sm text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Caps
          </a>
        }
      />
      <Briefing sentence={spendSentence(days, spent, cap)}>
        {spendFigures(spent, cap, byModule).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>

      <Section title="Spend by module" description="Owner workspace, this month">
        <DataTable
          searchable={false}
          filename="spend-by-module"
          columns={[
            { key: "module", label: "Module" },
            { key: "calls", label: "Calls", format: "number" },
            { key: "cost", label: "Cost", format: "usd" },
          ]}
          rows={byModule}
          initialSort={{ key: "cost", desc: true }}
        />
      </Section>

      <Section title="Recent API calls" description="Owner workspace, the newest 200">
        <DataTable
          filename="api-ledger"
          columns={[
            { key: "createdAt", label: "Time", format: "datetime" },
            { key: "module", label: "Module", format: "badge" },
            { key: "source", label: "Started by" },
            { key: "endpoint", label: "Endpoint" },
            { key: "tasks", label: "Tasks", format: "number" },
            { key: "statusCode", label: "Status" },
            { key: "chargedUsd", label: "Charged", format: "usd" },
            { key: "costUsd", label: "DataForSEO cost", format: "usd" },
          ]}
          rows={recent.map((r) => ({ ...r, source: r.source === "mcp" ? "AI agent" : "SEOpen" }))}
        />
      </Section>

      <Section title="Background jobs" description="The last 7 days">
        <DataTable
          filename="jobs"
          columns={[
            { key: "name", label: "Job" },
            { key: "state", label: "State", format: "badge" },
            { key: "n", label: "Count", format: "number" },
            { key: "last", label: "Last activity", format: "datetime" },
          ]}
          rows={jobs}
        />
      </Section>

      <div id="caps" className="scroll-mt-16">
        <Section title="Caps" description="What stops paid calls.">
          <div className="grid gap-6 @3xl/main:grid-cols-2">
            <Card>
              <CardHeader title="Platform cap" description={`Stops every workspace's paid calls once DataForSEO's bill this month reaches it. ${formatUsd(platform.spentUsd, 2)} spent so far.`} />
              <CardBody>
                <ActionForm action={setPlatformCap} className="flex items-end gap-2">
                  <Label className="flex-1">
                    Cap (USD)
                    <Input name="cap" type="number" required min={1} max={PLATFORM_CAP_MAX} step={1} defaultValue={platformCap} />
                  </Label>
                  <Button type="submit">Save</Button>
                </ActionForm>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Owner workspace cap" description="The owner workspace's paid calls stop once this month's spend reaches it. Cached results still load." />
              <CardBody>
                <ActionForm action={setOwnerCap} className="flex items-end gap-2">
                  <Label className="flex-1">
                    Cap (USD)
                    <Input name="cap" type="number" required min={1} max={OWNER_CAP_MAX} step={1} defaultValue={cap} />
                  </Label>
                  <Button type="submit">Save</Button>
                </ActionForm>
              </CardBody>
            </Card>
          </div>
        </Section>
      </div>
    </>
  );
}
