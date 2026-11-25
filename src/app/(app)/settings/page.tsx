import { eq } from "drizzle-orm";
import Link from "next/link";
import { setAlertEmails, setTimeZone, setWeeklyRecap } from "@/app/actions/settings";
import { DeleteWorkspace } from "@/components/delete-workspace";
import { ExportWorkspace } from "@/components/export-workspace";
import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { SignOutElsewhereForm } from "@/components/settings/sign-out-elsewhere-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { db } from "@/db";
import { users } from "@/db/schema";
import { isAdmin } from "@/lib/admin/access";
import { requireSession } from "@/lib/auth/session";
import { signInMethods } from "@/lib/auth/sign-in-methods";
import { formatDateTime } from "@/lib/format";
import { RECAP_AT, recapOpen } from "@/lib/recap/gate";
import { mondayJobTime } from "@/lib/schedule";
import { timeZoneOptions, zoneLabel } from "@/lib/time-zones";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";
import { deleteWorkspaceDescription } from "@/lib/workspace/delete-copy";
import { exportTablesFor } from "@/lib/workspace/export";
import { exportLabel } from "@/lib/workspace/export-labels";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";

export const metadata = { title: "Workspace settings" };

/** Settings for the whole workspace. Each project's own are on /projects/[id]/settings. */
export default async function SettingsPage() {
  const [user, workspace, timeZone] = await Promise.all([requireSession(), currentWorkspace(), currentTimeZone()]);
  const now = new Date();
  const methods = await signInMethods(user.id);
  const me = recapOpen(workspace) ? (await db.select({ on: users.weeklyRecap, alerts: users.alertEmails }).from(users).where(eq(users.id, user.id)))[0] : undefined;
  const recap = recapOpen(workspace) ? { on: me?.on ?? false, alerts: me?.alerts ?? true, when: mondayJobTime(RECAP_AT, timeZone, now) } : null;

  return (
    <>
      <PageHeader title="Workspace settings" description="These apply to everyone in this workspace. Each project has its own Project settings in the sidebar." />
      <div className="flex max-w-2xl flex-col gap-6">
        <Card>
          <CardHeader
            title="Time zone"
            description={`Dates and times in SEOpen read in ${zoneLabel(timeZone, now)}, where it's ${formatDateTime(now, timeZone)}.`}
          />
          <CardBody className="flex flex-col gap-3">
            <form action={setTimeZone} className="flex flex-wrap items-end gap-3">
              <Label className="min-w-0 flex-1 basis-64">
                Time zone
                {/* The key remounts the field with the saved zone; React's form reset would otherwise put back the old one. */}
                <Select key={timeZone} name="timeZone" defaultValue={timeZone} className="w-full">
                  {timeZoneOptions(timeZone, now).map((group) => (
                    <optgroup key={group.region} label={group.region}>
                      {group.zones.map((zone) => (
                        <option key={zone.value} value={zone.value}>
                          {zone.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Label>
              <Button type="submit">Save</Button>
            </form>
            <p className="text-xs text-muted">
              Scheduled checks stay on the same clock for every workspace, so this changes how their times read, not when they run. The docs list them under{" "}
              <a href="/docs/getting-started/schedule" target="_blank" rel="noopener" className="underline hover:text-fg">
                What runs on its own
              </a>
              .
            </p>
          </CardBody>
        </Card>
        {recap && (
          <Card>
            <CardHeader
              title="Weekly recap email"
              description={`An email on ${recap.when.days} at ${recap.when.zoned} with what moved in each project that week: rankings, Search Console clicks, AI answers naming you, new audit issues and open fixes. It goes to ${user.email} only, and skips a week with nothing to say.`}
            />
            <CardBody>
              <form action={setWeeklyRecap.bind(null, !recap.on)} className="flex flex-wrap items-center justify-between gap-3">
                <Badge tone={recap.on ? "good" : "neutral"}>{recap.on ? "On" : "Off"}</Badge>
                <Button size="sm" variant={recap.on ? "secondary" : "primary"} type="submit">
                  {recap.on ? "Turn off" : "Turn on"}
                </Button>
              </form>
            </CardBody>
          </Card>
        )}
        {recap && (
          <Card>
            <CardHeader
              title="Alert emails"
              description={`With the weekly recap on, an email when a page with Search Console clicks breaks, a search crawler is newly blocked or a tracked keyword leaves the top 10. At most one a day per project, sooner for a broken page or a blocked crawler. Each project's rules are on its Alerts page.${recap.on ? "" : " The weekly recap is off, so none are sent."}`}
            />
            <CardBody>
              <form action={setAlertEmails.bind(null, !recap.alerts)} className="flex flex-wrap items-center justify-between gap-3">
                <Badge tone={recap.alerts && recap.on ? "good" : "neutral"}>{recap.alerts ? (recap.on ? "On" : "On, waiting for the recap") : "Off"}</Badge>
                <Button size="sm" variant="secondary" type="submit">
                  {recap.alerts ? "Turn off" : "Turn on"}
                </Button>
              </form>
            </CardBody>
          </Card>
        )}
        {methods.password && (
          <Card>
            <CardHeader
              title="Your password"
              description={`For ${user.email} only. Changing it signs you out in every other browser, revokes the API keys you made and disconnects your connected apps.`}
            />
            <CardBody>
              <ChangePasswordForm email={user.email} />
            </CardBody>
          </Card>
        )}
        {!methods.password && methods.google && (
          <Card>
            <CardHeader title="Your password" description={`${user.email} signs in with Google and has no password.`} />
            <CardBody>
              <Link href="/forgot-password" className="text-sm underline hover:text-fg">
                Email me a link to set one
              </Link>
            </CardBody>
          </Card>
        )}
        {(methods.password || methods.google) && (
          <Card>
            <CardHeader
              title="Sign out everywhere else"
              description={`Signs ${user.email} out in every browser but this one.${methods.google ? " If someone may have got into your Google account, secure it first, or they can sign back in." : ""}${methods.password ? " If someone else may know your password, change it above instead, which does this too." : ""}`}
            />
            <CardBody>
              <SignOutElsewhereForm />
            </CardBody>
          </Card>
        )}
        <Card>
          <CardHeader title="Export your data" description="Everything stored for this workspace, for you to keep." />
          <CardBody>
            <ExportWorkspace tables={(await exportTablesFor({ workspaceId: workspace.id })).map((name) => ({ name, label: exportLabel(name) }))} />
          </CardBody>
        </Card>
        {workspace.id !== OWNER_WORKSPACE_ID && (
          <Card>
            <CardHeader
              title="Delete this workspace"
              description={deleteWorkspaceDescription(await isAdmin(user.id))}
            />
            <CardBody>
              <DeleteWorkspace />
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
