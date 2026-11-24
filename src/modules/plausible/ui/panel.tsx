import { ApiError } from "@/components/api-error";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { Input, Label, Select } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, workspaceScope } from "@/lib/workspace/current";
import { connectPlausible, disconnectPlausible, setPlausibleSite } from "../actions";
import { fixtureMode, getPlausibleConnectionInfo, type PlausibleConnectionInfo } from "../account";
import { listPlausibleSites } from "../sites";
import { getPlausibleSyncState } from "../sync";
import { PlausibleAccessError, type PlausibleSite } from "../types";

export type PlausibleConnection = { state: "fixtures" } | { state: "not_connected" } | { state: "reauth"; account: PlausibleConnectionInfo } | { state: "connected"; account: PlausibleConnectionInfo };

export async function getPlausibleConnection(): Promise<PlausibleConnection> {
  if (fixtureMode()) return { state: "fixtures" };
  const account = await getPlausibleConnectionInfo((await workspaceScope()).workspaceId);
  if (account?.status === "reauth_required") return { state: "reauth", account };
  if (account) return { state: "connected", account };
  return { state: "not_connected" };
}

const isUsable = (c: PlausibleConnection) => c.state === "fixtures" || c.state === "connected";

/** The form a key is pasted into. It goes one way: nothing on this page ever holds the saved key. */
function ConnectForm({ again }: { again?: boolean }) {
  return (
    // ph-no-capture: SEOpen's own product analytics stays off this form.
    <ActionForm action={connectPlausible} className="ph-no-capture flex flex-wrap items-end gap-2">
      <Label className="min-w-0 flex-[1_1_16rem]">
        Stats API key
        <Input name="plausibleKey" type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" required />
      </Label>
      <Button type="submit">{again ? "Reconnect Plausible" : "Connect Plausible"}</Button>
    </ActionForm>
  );
}

/** What the page says about Plausible before its numbers, since the panel sits at the end of the page. */
export function PlausibleNotices({ project, connection }: { project: Project; connection: PlausibleConnection }) {
  if (connection.state === "reauth" && project.plausibleSite) {
    return (
      <div className="mb-4">
        <Callout tone="bad" title="Reconnect Plausible">
          Plausible stopped accepting this workspace&apos;s key, so syncs are paused.{" "}
          <a href="#plausible" className="text-accent hover:underline">
            Reconnect
          </a>
        </Callout>
      </div>
    );
  }
  return null;
}

/**
 * For a project still on Plausible in a workspace the gate keeps closed: only a way to stop using it, since
 * nothing else about Plausible can be set up there. The page shows this in place of the panel.
 */
export function PlausibleStop({ project }: { project: Project }) {
  return (
    <Card id="plausible" className="scroll-mt-4">
      <CardHeader title="Plausible" description={`${project.name} reads its Analytics from Plausible, which this workspace can't set up. You can stop using it and pick another source.`} />
      <CardBody className="text-sm">
        <ActionForm action={setPlausibleSite.bind(null, project.id)}>
          <input type="hidden" name="plausibleSite" value="" />
          <ConfirmSubmit variant="danger" question={`Stop using Plausible for ${project.name}? Its stored Plausible numbers are cleared.`} confirmLabel="Stop using Plausible">
            Stop using Plausible
          </ConfirmSubmit>
        </ActionForm>
      </CardBody>
    </Card>
  );
}

/** Plausible as the project's Analytics source: paste a key, pick the site for this SEOpen project, or disconnect. */
export async function PlausiblePanel({ project, connection }: { project: Project; connection: PlausibleConnection }) {
  const timeZone = await currentTimeZone();
  let sites: PlausibleSite[] | null = null;
  let listError: unknown = null;
  if (isUsable(connection)) {
    try {
      sites = await listPlausibleSites((await workspaceScope()).workspaceId);
    } catch (e) {
      listError = e;
    }
  }
  const usingPlausible = !!project.plausibleSite;
  // The connection can be fine while the sync has lost this site. The sync row says what's wrong, so the way to fix it is here.
  const syncLostAccess = connection.state === "connected" && usingPlausible && (await getPlausibleSyncState(projectScope(project)))?.status === "reauth";
  const otherSource = project.ga4Property ? "GA4" : project.posthogProject ? "PostHog" : project.umamiSite ? "Umami" : null;
  // Saving clears the stored numbers of whichever source this replaces, so that's asked first.
  const replaces = usingPlausible ? `Change this project's Plausible site? Its stored Plausible numbers are cleared and synced again.` : otherSource ? `Use Plausible instead of ${otherSource} for ${project.name}? Its stored ${otherSource} numbers are cleared.` : null;

  return (
    <Card id="plausible" className="scroll-mt-4">
      <CardHeader title="Plausible" description="Visits from search per landing page from Plausible Cloud. Read-only: a Stats API key can't change anything in Plausible, and SEOpen only reads your site list and these visits." />
      <CardBody className="flex flex-col gap-3 text-sm">
        {connection.state === "fixtures" && (
          <Callout tone="warn" title="Fixture data">
            SEOPEN_PLAUSIBLE_FIXTURES=1 is set, so the Plausible sites and numbers here are generated test data.
          </Callout>
        )}
        {connection.state === "not_connected" && (
          <>
            <p className="max-w-[72ch] text-muted">
              Use Plausible for this project. In your Plausible account settings, open API Keys, choose New API Key and pick Stats API, then paste it here. Plausible includes the Stats API on its Business plan. SEOpen checks the key with Plausible, stores it encrypted, and never shows it again.
            </p>
            <ConnectForm />
          </>
        )}
        {connection.state === "reauth" && (
          <>
            <Callout tone="bad" title="Reconnect needed">
              Plausible stopped accepting the saved key, usually because it was deleted in Plausible. Syncs are paused until you paste a new one.
            </Callout>
            <ConnectForm again />
          </>
        )}
        {connection.state === "connected" && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="good">Connected</Badge>
            <span>Plausible Cloud</span>
            <span className="text-muted">since {formatDateTime(connection.account.connectedAt, timeZone)}</span>
            <form action={disconnectPlausible} className="ml-auto">
              <ConfirmSubmit variant="danger" question="Disconnect Plausible for this workspace? SEOpen deletes its copy of the key and syncs stop. The key keeps working in Plausible until you delete it there." confirmLabel="Disconnect">
                Disconnect
              </ConfirmSubmit>
            </form>
          </div>
        )}
        {listError != null && <ApiError error={listError} />}
        {(listError instanceof PlausibleAccessError || syncLostAccess) && <ConnectForm again />}
        {sites && (
          <ActionForm action={setPlausibleSite.bind(null, project.id)} className="flex flex-wrap items-center gap-2">
            <Select name="plausibleSite" defaultValue={project.plausibleSite ?? ""} className="h-8 w-full max-w-80 text-xs" aria-label={`Plausible site for ${project.name}`}>
              <option value="">{usingPlausible ? "None (stop using Plausible)" : "Choose a Plausible site"}</option>
              {/* A disconnected-and-reconnected key may no longer list the site in use. */}
              {project.plausibleSite && !sites.some((s) => s.domain === project.plausibleSite) && <option value={project.plausibleSite}>{project.plausibleSite} (no access)</option>}
              {sites.map((s) => (
                <option key={s.domain} value={s.domain}>
                  {s.domain}
                </option>
              ))}
            </Select>
            {replaces ? (
              <ConfirmSubmit question={replaces} confirmLabel={usingPlausible ? "Save" : "Use Plausible"}>
                {usingPlausible ? "Save" : `Use for ${project.name}`}
              </ConfirmSubmit>
            ) : (
              <Button size="sm" variant="secondary" type="submit">
                {`Use for ${project.name}`}
              </Button>
            )}
            {!usingPlausible && otherSource && <span className="text-xs text-muted">Replaces {otherSource} as this project&apos;s Analytics source.</span>}
          </ActionForm>
        )}
        {sites?.length === 0 && <p className="text-muted">This key can&apos;t see any sites. Plausible keys belong to one team, so create it in the team that owns the site.</p>}
      </CardBody>
    </Card>
  );
}
