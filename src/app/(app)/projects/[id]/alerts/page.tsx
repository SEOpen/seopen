import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/ui/back-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getProject } from "@/lib/projects";
import { recapOpen } from "@/lib/recap/gate";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { setAlertRule } from "@/modules/alerts/actions";
import { listAlerts } from "@/modules/alerts/queries";
import { ruleStates } from "@/modules/alerts/record";
import { RULES } from "@/modules/alerts/rules";

export const metadata = { title: "Alerts" };

/** How many alerts the history shows, newest first. */
const HISTORY = 100;

/** What reaches this person's inbox, in a sentence. */
function emailLine(open: boolean, me: { recap: boolean; alerts: boolean } | undefined): string {
  if (!open) return "Alert emails come with the weekly recap, which this workspace's plan doesn't have yet. Alerts still show here.";
  if (!me?.recap) return "Alert emails go to people who get the weekly recap. Yours is off, so they show here only. Turn it on in Settings.";
  if (!me.alerts) return "You turned alert emails off in Settings, so they show here only.";
  return "They're emailed to you and anyone else in the workspace who gets the weekly recap: at most one email a day per project, sooner for a broken page or a blocked crawler.";
}

/** A project's alert rules, each on or off, and every alert they found. */
export default async function AlertsPage({ params }: PageProps<"/projects/[id]/alerts">) {
  const id = Number((await params).id);
  const project = Number.isInteger(id) ? await getProject(id) : null;
  if (!project || project.archived) notFound();
  const scope = projectScope(project);
  const [user, workspace, timeZone, rules, history] = await Promise.all([requireSession(), currentWorkspace(), currentTimeZone(), ruleStates(scope), listAlerts(scope, { limit: HISTORY })]);
  const [me] = await db.select({ recap: users.weeklyRecap, alerts: users.alertEmails }).from(users).where(eq(users.id, user.id));
  const open = history.filter((a) => !a.resolvedAt).length;

  return (
    <>
      <BackLink href={`/projects/${project.id}`}>{project.name} overview</BackLink>
      <PageHeader
        title="Alerts"
        description={`Problems on ${project.domain} worth knowing before the weekly recap, found when a site audit crawl or a rank check finishes. ${emailLine(recapOpen(workspace), me)}`}
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <CardHeader title="Rules" description="Each rule is on unless you turn it off. Turning one off stops new alerts; the history stays." />
          <CardBody className="p-0">
            <ul className="divide-y divide-line-soft">
              {rules.map(({ rule, enabled }) => {
                const info = RULES[rule];
                return (
                  <li key={rule} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 max-w-xl">
                      <p className="text-sm font-medium">
                        {info.label}
                        {info.urgent && <span className="ml-2 text-xs font-normal text-secondary">Urgent: emails at once</span>}
                      </p>
                      <p className="text-sm text-secondary">{info.description}</p>
                    </div>
                    <form action={setAlertRule.bind(null, project.id, rule, !enabled)} className="flex shrink-0 items-center gap-3">
                      <Badge tone={enabled ? "good" : "neutral"}>{enabled ? "On" : "Off"}</Badge>
                      <Button size="sm" variant="secondary" type="submit" aria-label={`${enabled ? "Turn off" : "Turn on"}: ${info.label}`}>
                        {enabled ? "Turn off" : "Turn on"}
                      </Button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      </div>
      <Section
        title="History"
        description={history.length ? `${formatNumber(open)} open. ${history.length === HISTORY ? `The latest ${HISTORY}, newest first.` : "Newest first."} An alert closes when a later check finds it fixed.` : undefined}
      >
        {history.length ? (
          <ul className="panel max-w-3xl divide-y divide-line-soft">
            {history.map((a) => (
              <li key={a.id} id={`alert-${a.id}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 [overflow-wrap:anywhere]">
                <div className="min-w-0 max-w-xl">
                  <p className="text-sm font-medium">{a.title}</p>
                  {a.detail && <p className="text-sm text-secondary">{a.detail}</p>}
                  <p className="mt-1 text-xs text-secondary">
                    {a.source}, found {formatDateTime(a.detectedAt, timeZone)}
                    {a.resolvedAt ? `. Fixed by ${formatDateTime(a.resolvedAt, timeZone)}` : ""}
                    {a.emailedAt ? `. Emailed ${formatDateTime(a.emailedAt, timeZone)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge tone={a.resolvedAt ? "neutral" : a.urgent ? "bad" : "warn"}>{a.resolvedAt ? "Fixed" : "Open"}</Badge>
                  <Link href={`/projects/${project.id}/alerts/${a.id}`} prefetch={false} className="text-sm text-accent underline-offset-2 hover:underline">
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No alerts yet"
            description="Alerts show here when a site audit crawl finds a page with Search Console clicks broken or a search crawler newly blocked, or a rank check finds a tracked keyword out of the top 10."
          />
        )}
      </Section>
    </>
  );
}
