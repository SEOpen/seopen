import { asc, sql } from "drizzle-orm";
import { columnsWithData, usersSentence } from "@/components/admin/brief";
import { Briefing } from "@/components/ui/briefing";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { Figure } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { db } from "@/db";
import { users } from "@/db/schema";
import { removeAdminFromForm } from "@/app/actions/admin";
import { ActionForm } from "@/components/ui/action-form";
import { AddAdminForm } from "@/components/admin/add-admin-form";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { adminUserIds, requireAdmin } from "@/lib/admin/access";
import { formatNumber } from "@/lib/format";

// Inside correlated subqueries a bare "id" would resolve to the inner table, so name the outer column in full.
const userId = sql.raw('"users"."id"');

export const metadata = { title: "Users · Admin" };

const COLUMNS: ColumnSpec[] = [
  { key: "email", label: "Email", format: "link", href: "/admin/users/{id}" },
  { key: "name", label: "Name" },
  { key: "workspace", label: "Workspace", format: "link", href: "/admin/workspaces/{workspaceId}" },
  { key: "verified", label: "Verified", format: "badge" },
  { key: "methods", label: "Signs in with" },
  { key: "createdAt", label: "Signed up", format: "datetime" },
  { key: "lastSeen", label: "Last seen", format: "datetime" },
];

/**
 * Every account: when it signed up, whether its email is verified, how it signs in, when it was last
 * seen (its newest session) and the workspace it belongs to. An email opens the account's own page. Then who can open Admin, with the form
 * that changes it.
 */
export default async function AdminUsersPage() {
  const [me, adminIds] = await Promise.all([requireAdmin(), adminUserIds()]);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      verified: sql<string>`case when ${users.emailVerified} then 'Verified' else 'Not verified' end`,
      createdAt: sql<string>`${users.createdAt}::text`,
      newThisWeek: sql<boolean>`${users.createdAt} > now() - interval '7 days'`,
      lastSeen: sql<string | null>`(select max(s.updated_at)::text from sessions s where s.user_id = ${userId})`,
      seenThisWeek: sql<boolean>`exists (select 1 from sessions s where s.user_id = ${userId} and s.updated_at > now() - interval '7 days')`,
      methods: sql<string>`coalesce((select string_agg(distinct case a.provider_id when 'credential' then 'Password' when 'google' then 'Google' else a.provider_id end, ', ') from accounts a where a.user_id = ${userId}), '')`,
      workspaceId: sql<number | null>`(select min(m.workspace_id) from workspace_members m where m.user_id = ${userId})`,
      workspace: sql<string>`coalesce((select string_agg(w.name, ', ' order by w.id) from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = ${userId}), '–')`,
    })
    .from(users)
    .orderBy(asc(users.createdAt));

  const admins = adminIds.map((id) => rows.find((r) => r.id === id)).filter((r) => r !== undefined);
  const verified = rows.filter((r) => r.verified === "Verified").length;
  const newThisWeek = rows.filter((r) => r.newThisWeek).length;
  const seenThisWeek = rows.filter((r) => r.seenThisWeek).length;

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with an account, read live: how they sign in and when they were last seen. Who can open Admin is below the table."
        actions={
          <a href="#admins" className="rounded-sm text-sm text-muted underline-offset-4 hover:text-fg hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Admins
          </a>
        }
      />
      <Briefing sentence={usersSentence({ accounts: rows.length, newThisWeek, seenThisWeek, unverified: rows.length - verified })}>
        <Figure label="Accounts" value={formatNumber(rows.length)} />
        <Figure label="Verified email" value={formatNumber(verified)} />
        <Figure label="Signed up in the last 7 days" value={formatNumber(newThisWeek)} />
        <Figure label="Seen in the last 7 days" value={formatNumber(seenThisWeek)} />
      </Briefing>

      <Section title="Accounts">
        <DataTable filename="users" columns={columnsWithData(COLUMNS, rows)} rows={rows} initialSort={{ key: "createdAt", desc: true }} />
      </Section>

      <Card id="admins" className="mt-8 scroll-mt-16">
        <CardHeader
          title="Admins"
          description={
            adminIds.length
              ? "Only these accounts can open Admin. Each has a workspace of its own for the app."
              : "Nobody is on the list yet, so the owner workspace's members are the admins. The first admin you add replaces that."
          }
        />
        <CardBody className="flex flex-col gap-4">
          {admins.length > 0 && (
            <ul className="divide-y divide-line-soft border-y border-line-soft">
              {admins.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-medium">{a.email}</span>
                    {a.id === me.id && <span className="text-muted"> (you)</span>}
                    {!a.methods && <span className="text-muted"> · hasn&apos;t signed in yet</span>}
                  </span>
                  {admins.length > 1 && (
                    <ActionForm action={removeAdminFromForm} align="end">
                      <input type="hidden" name="userId" value={a.id} />
                      <ConfirmSubmit
                        question={a.id === me.id ? "Remove yourself? You lose Admin straight away." : `Remove ${a.email} from the admins?`}
                        confirmLabel="Remove"
                        variant="danger"
                        aria-label={`Remove ${a.email} from the admins`}
                      >
                        Remove
                      </ConfirmSubmit>
                    </ActionForm>
                  )}
                </li>
              ))}
            </ul>
          )}
          <AddAdminForm firstAdmin={adminIds.length === 0} />
          <p className="text-xs text-muted">A new address gets an account and an email to choose a password. It doesn&apos;t use a beta seat.</p>
        </CardBody>
      </Card>
    </>
  );
}
