import { asc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { deleteUserAsAdmin } from "@/app/actions/admin";
import { columnsWithData } from "@/components/admin/brief";
import { AdminDeleteForm } from "@/components/admin/delete-form";
import { BackLink } from "@/components/ui/back-link";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { db } from "@/db";
import { users, workspaceMembers, workspaces } from "@/db/schema";
import { requireAdmin } from "@/lib/admin/access";
import { userDeletion } from "@/lib/workspace/delete";
import { adminDeleteUserDescription } from "@/lib/workspace/delete-copy";

export const metadata = { title: "User · Admin" };

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "Workspace", format: "link", href: "/admin/workspaces/{id}" },
  { key: "role", label: "Role", format: "badge" },
  { key: "status", label: "Status", format: "badge" },
  { key: "createdAt", label: "Created", format: "datetime" },
];

/** One account: the workspaces it belongs to, and the form that deletes it or why it can't be. */
export default async function AdminUserPage({ params }: PageProps<"/admin/users/[id]">) {
  const me = await requireAdmin();
  const { id } = await params;
  const [[user], rows] = await Promise.all([
    db.select({ id: users.id, email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, id)),
    db
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role, status: workspaces.status, createdAt: sql<string>`${workspaces.createdAt}::text` })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, id))
      .orderBy(asc(workspaces.id)),
  ]);
  if (!user) notFound();
  const deletion = await userDeletion(id, me.id);

  return (
    <>
      <BackLink href="/admin/users">All users</BackLink>
      <PageHeader title={user.email} description={user.emailVerified ? "Verified email, read live." : "This email hasn't been verified."} />
      <Section title="Workspaces">
        <DataTable searchable={false} filename="user-workspaces" columns={columnsWithData(COLUMNS, rows)} rows={rows} />
      </Section>
      <Card className="mt-8">
        <CardHeader title="Delete this account" description={deletion.refusal ?? adminDeleteUserDescription(deletion.workspaces.map((w) => w.name))} />
        {!deletion.refusal && (
          <CardBody>
            <AdminDeleteForm action={deleteUserAsAdmin} name="userId" value={user.id} label="Delete account" />
          </CardBody>
        )}
      </Card>
    </>
  );
}
