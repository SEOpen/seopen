import { and, asc, count, eq, gte, isNull, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { setWorkspaceSuspended } from "@/app/actions/billing";
import { ceilingCaption, columnsWithData, workspaceSentence } from "@/components/admin/brief";
import { BackLink } from "@/components/ui/back-link";
import { Briefing } from "@/components/ui/briefing";
import { Button } from "@/components/ui/button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { Figure } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { db } from "@/db";
import { apiKeys, apiLedger, googleAccounts, plausibleAccounts, posthogAccounts, projects, umamiAccounts, users, workspaceMembers, workspaces, workspaceUsage } from "@/db/schema";
import { aiAssistantForVisit } from "@/lib/ai-referrers";
import { failedJobs, pausedJobs, syncProblems } from "@/lib/admin/health";
import { creditsUsed, limitsFor } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { formatDateTime, formatNumber, formatUsd } from "@/lib/format";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";
import { requireAdmin } from "@/lib/admin/access";
import { currentTimeZone } from "@/lib/workspace/current";
import { admin } from "@/plan-policy/admin";
import { rules } from "@/plan-policy/rules";
import { shell as plan } from "@/plan-policy/shell";

// Inside correlated subqueries a bare "id" would resolve to the inner table, so name the outer column in full.
const userId = sql.raw('"users"."id"');

export const metadata = { title: "Workspace · Admin" };

const MEMBER_COLUMNS: ColumnSpec[] = [
  { key: "email", label: "Email" },
  { key: "name", label: "Name" },
  { key: "role", label: "Role", format: "badge" },
  { key: "verified", label: "Verified", format: "badge" },
  { key: "lastSeen", label: "Last seen", format: "datetime" },
];

const PROJECT_COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Project" },
  { key: "domain", label: "Domain" },
  { key: "searchConsole", label: "Search Console" },
  { key: "analytics", label: "Analytics", format: "badge" },
  { key: "state", label: "State", format: "badge" },
  { key: "createdAt", label: "Added", format: "datetime" },
];

/** Labels beside their values, for a stored reading that isn't a table. */
function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-secondary">{label}</dt>
          <dd className="[overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One workspace in full: what needs attention, its members, projects and spend by module this month,
 * with its plan, what the plan policy adds (`@/plan-policy/admin`) and connections beside them.
 * Read-only apart from Suspend and the plan policy's own form.
 */
export default async function AdminWorkspacePage({ params }: PageProps<"/admin/workspaces/[id]">) {
  await requireAdmin();
  const timeZone = await currentTimeZone();
  const when = (d: Date | null) => formatDateTime(d, timeZone);
  const id = Number((await params).id);
  // Past the integer column's range Postgres raises an error instead of finding nothing.
  if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) notFound();

  const month = sql`date_trunc('month', now())`;
  const [[ws], [usage], members, projectRows, [google], [posthog], [plausible], [umami], [keys], byModule, failed, syncs, paused, [owner]] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.id, id)),
    db
      .select({ spentUsd: sql<number>`${workspaceUsage.spentUsd}::float`, researchUsd: sql<number>`${workspaceUsage.researchUsd}::float` })
      .from(workspaceUsage)
      .where(and(eq(workspaceUsage.workspaceId, id), eq(workspaceUsage.month, sql`${month}::date`))),
    db
      .select({
        email: users.email,
        name: users.name,
        role: workspaceMembers.role,
        verified: sql<string>`case when ${users.emailVerified} then 'Verified' else 'Not verified' end`,
        lastSeen: sql<string | null>`(select max(s.updated_at)::text from sessions s where s.user_id = ${userId})`,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id)),
    db
      .select({
        name: projects.name,
        domain: projects.domain,
        searchConsole: sql<string>`coalesce(${projects.gscProperty}, '–')`,
        analytics: sql<string>`case when ${projects.umamiSite} is not null then 'Umami' when ${projects.plausibleSite} is not null then 'Plausible' when ${projects.posthogProject} is not null then 'PostHog' when ${projects.ga4Property} is not null then 'GA4' else '–' end`,
        state: sql<string>`case when ${projects.archived} then 'Archived' else 'Active' end`,
        createdAt: sql<string>`${projects.createdAt}::text`,
      })
      .from(projects)
      .where(eq(projects.workspaceId, id))
      .orderBy(asc(projects.id)),
    db.select().from(googleAccounts).where(eq(googleAccounts.workspaceId, id)),
    db.select().from(posthogAccounts).where(eq(posthogAccounts.workspaceId, id)),
    // Never the key column: only what the Connections row shows.
    db.select({ status: plausibleAccounts.status, lastError: plausibleAccounts.lastError }).from(plausibleAccounts).where(eq(plausibleAccounts.workspaceId, id)),
    db.select({ baseUrl: umamiAccounts.baseUrl, status: umamiAccounts.status, lastError: umamiAccounts.lastError }).from(umamiAccounts).where(eq(umamiAccounts.workspaceId, id)),
    db
      .select({ n: count() })
      .from(apiKeys)
      .where(and(eq(apiKeys.workspaceId, id), isNull(apiKeys.revokedAt))),
    db
      .select({
        module: apiLedger.module,
        calls: sql<number>`count(*)::int`,
        cost: sql<number>`sum(${apiLedger.chargedUsd})::float`,
        agents: sql<number>`coalesce(sum(${apiLedger.chargedUsd}) filter (where ${apiLedger.source} = 'mcp'), 0)::float`,
      })
      .from(apiLedger)
      .where(and(eq(apiLedger.workspaceId, id), gte(apiLedger.createdAt, month)))
      .groupBy(apiLedger.module),
    failedJobs(7, id),
    syncProblems(id),
    pausedJobs(id),
    // Where the account that made the workspace first came to the site from (src/lib/first-visit.ts).
    db
      .select({ source: users.firstSource, referrerHost: users.firstReferrerHost, landingPath: users.firstLandingPath })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.role, "owner")))
      .orderBy(asc(users.createdAt))
      .limit(1),
  ]);
  if (!ws) notFound();

  const limits = limitsFor(ws);
  // What its paid calls are refused against, not the plan's figure. Asked after the check above, since it throws on a missing workspace.
  const [{ ceilingUsd: ceiling }, extra] = await Promise.all([spendState(id), admin.workspace(ws, timeZone)]);
  const spent = usage?.spentUsd ?? 0;
  const suspended = ws.status === "suspended";
  const activeProjects = projectRows.filter((p) => p.state === "Active").length;

  const facts: [string, string][] = [
    ["Plan", `${rules.planLabel(ws.plan)}${extra.status ? ` · ${extra.status}` : ""}${suspended ? " · suspended" : ""}`],
    ["Created", when(ws.createdAt)],
    ...extra.facts,
  ];
  const connections: [string, string][] = [
    ["Google", google ? `${google.email} · ${google.status}${google.lastError ? ` · ${google.lastError}` : ""}` : "Not connected"],
    ["PostHog", posthog ? `${posthog.region.toUpperCase()} Cloud · ${posthog.status}${posthog.lastError ? ` · ${posthog.lastError}` : ""}` : "Not connected"],
    ["Plausible", plausible ? `Cloud · ${plausible.status}${plausible.lastError ? ` · ${plausible.lastError}` : ""}` : "Not connected"],
    ["Umami", umami ? `${umami.baseUrl ? `Self-hosted · ${umami.baseUrl}` : "Cloud"} · ${umami.status}${umami.lastError ? ` · ${umami.lastError}` : ""}` : "Not connected"],
    ["AI agent keys", keys?.n ? `${keys.n} active` : "None"],
  ];
  // The shared AI assistants list (src/lib/ai-referrers.ts) reads the stored referrer and source, so nothing new is stored.
  const firstAi = owner ? aiAssistantForVisit(owner) : null;
  const firstVisit: [string, string][] = [
    ["From an AI assistant", firstAi ? `Yes, ${firstAi.name}` : owner?.referrerHost || owner?.source ? "No" : "–"],
    ["Source", owner?.source ?? "–"],
    ["Referred by", owner?.referrerHost ?? "–"],
    ["Landed on", owner?.landingPath ?? "–"],
  ];
  // The same kinds and the same tests as Health. Failed runs, not the groups of them, so the figure and the sentence agree.
  const problems = {
    failed: failed.reduce((n, f) => n + f.n, 0),
    syncs: syncs.length,
    connections: [google, posthog, plausible, umami].filter((a) => a && (a.status !== "active" || a.lastError)).length,
    paused: paused.length,
    billing: extra.problems,
  };

  return (
    <>
      <BackLink href="/admin/workspaces">All workspaces</BackLink>
      <PageHeader
        title={ws.name}
        description={`Workspace #${ws.id}, read live. Everything it holds and anything that needs a look.`}
        actions={
          ws.id !== OWNER_WORKSPACE_ID && (
            <form action={setWorkspaceSuspended}>
              <input type="hidden" name="workspaceId" value={ws.id} />
              <input type="hidden" name="suspended" value={suspended ? "0" : "1"} />
              {suspended ? (
                <Button type="submit" variant="secondary">
                  Restore
                </Button>
              ) : (
                <ConfirmSubmit variant="danger" question={`Suspend ${ws.name}? Paid calls and jobs stop; data stays.`} confirmLabel="Suspend">
                  Suspend
                </ConfirmSubmit>
              )}
            </form>
          )
        }
      />
      <Briefing sentence={workspaceSentence({ plan: ws.plan, suspended, spentUsd: spent, ceilingUsd: ceiling, problems })}>
        <Figure label="Spent this month" value={formatUsd(spent, 2)} caption={ceilingCaption(ceiling)} />
        {rules.hasPlans ? (
          <Figure label="Research credits" value={formatNumber(creditsUsed(usage?.researchUsd ?? 0))} caption={Number.isFinite(limits.researchCredits) ? `of ${formatNumber(limits.researchCredits)}` : "unlimited"} />
        ) : (
          <Figure label="Research lookups" value={formatUsd(usage?.researchUsd ?? 0, 2)} caption="of this month's spend" />
        )}
        <Figure label="Projects" value={formatNumber(activeProjects)} caption={Number.isFinite(limits.projects) ? `of ${formatNumber(limits.projects)}` : undefined} />
        <Figure label="Needs a look" value={formatNumber(Object.values(problems).reduce((a, b) => a + b, 0))} caption={extra.problemsCaption} />
      </Briefing>

      <div className="mt-8 module-rail">
        <div className="[&>section:first-child]:mt-0">
          {failed.length + syncs.length + paused.length > 0 && (
            <Section title="Needs a look">
              <DataTable
                searchable={false}
                filename={`workspace-${ws.id}-problems`}
                columns={[
                  { key: "what", label: "What", format: "badge" },
                  { key: "subject", label: "Subject" },
                  { key: "detail", label: "Detail" },
                  { key: "at", label: "When", format: "datetime" },
                ]}
                rows={[
                  ...failed.map((f) => ({ what: "Failed job", subject: `${f.name} (${f.n}×)`, detail: f.error ?? "", at: f.last })),
                  ...syncs.map((s) => ({ what: `${s.sourceLabel} sync`, subject: s.domain, detail: s.detail, at: s.lastSuccessAt })),
                  ...paused.map((p) => ({ what: "Paused", subject: `${p.job} on ${p.domain}`, detail: p.message, at: p.pausedAt })),
                ]}
              />
            </Section>
          )}

          <Section title="Members">
            <DataTable searchable={false} filename={`workspace-${ws.id}-members`} columns={columnsWithData(MEMBER_COLUMNS, members)} rows={members} />
          </Section>

          <Section title="Projects">
            <DataTable searchable={false} filename={`workspace-${ws.id}-projects`} columns={columnsWithData(PROJECT_COLUMNS, projectRows)} rows={projectRows} />
          </Section>

          <Section title="Spend by module" description="This month">
            <DataTable
              searchable={false}
              filename={`workspace-${ws.id}-spend`}
              columns={[
                { key: "module", label: "Module" },
                { key: "calls", label: "Calls", format: "number" },
                { key: "cost", label: "Charged", format: "usd" },
                { key: "agents", label: "By AI agents", format: "usd" },
              ]}
              rows={byModule}
              initialSort={{ key: "cost", desc: true }}
            />
          </Section>
        </div>

        <div>
          <Section title={extra.title} className="mt-0">
            <Facts items={facts} />
          </Section>
          <plan.WorkspaceGrant ws={ws} />
          <Section title="Connections">
            <Facts items={connections} />
          </Section>
          <Section title="First visit" description="Where the owner first came to the site from, when they signed up">
            <Facts items={firstVisit} />
          </Section>
        </div>
      </div>
    </>
  );
}
