import Link from "next/link";
import { createProjectFromForm } from "@/app/actions/projects";
import { UpgradeNow } from "@/components/plan-upgrade";
import { ProjectForm } from "@/components/project-form";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { isFree, limitsFor, upgradeRaises } from "@/lib/billing/gates";
import { spendBlock } from "@/lib/billing/spend";
import { auditRefusal, loadBillingWorkspace, projectGate } from "@/lib/billing/workspace";
import { workspaceScope } from "@/lib/workspace/current";
import { rules } from "@/plan-policy/rules";
import { otherSourceChoices } from "@/modules/analytics-source/choices";
import { googleChoices } from "@/modules/google/properties";
import { newProjectChoices, newProjectDescription } from "./choices";

export const metadata = { title: "New project" };

export default async function NewProjectPage() {
  const { workspaceId } = await workspaceScope();
  const ws = await loadBillingWorkspace(workspaceId);
  const gate = await projectGate(ws);
  // A Starter trial already has Starter's 2 projects, so Upgrade now shows only when it adds some.
  const upgradeHelps = upgradeRaises(ws, "projects");
  const free = isFree(ws);
  // What Create and audit would meet: Start crawl's own gates, short of the new project's (it isn't locked, and nothing runs on it yet).
  const auditBlocked = free && gate.ok ? ((await spendBlock(workspaceId)) ?? (await auditRefusal(ws))) : null;
  const choices = newProjectChoices(free, limitsFor(ws).auditPages, auditBlocked?.message ?? null);
  return (
    <>
      <PageHeader title="New project" description={newProjectDescription(ws)} />
      <div className="max-w-2xl">
        {gate.ok ? (
          <Card>
            <CardBody>
              <ProjectForm
                action={createProjectFromForm}
                next={choices.next ?? undefined}
                submitLabel={choices.submitLabel}
                hint={choices.hint ?? undefined}
                withCompetitors
                // Not awaited: the form shows at once and the properties stream in behind it.
                googleChoices={googleChoices(workspaceId)}
                analyticsChoices={otherSourceChoices(workspaceId, ws)}
              />
            </CardBody>
          </Card>
        ) : (
          <Callout tone="warn" title="Project limit reached">
            {gate.message}{" "}
            {rules.plansHref && (
              <Link href={rules.plansHref} className="font-medium text-accent underline-offset-2 hover:underline">
                See your plan
              </Link>
            )}
            {upgradeHelps && <UpgradeNow size="sm" className="mt-3" />}
          </Callout>
        )}
      </div>
    </>
  );
}
