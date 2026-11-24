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
import { connectUmami, disconnectUmami, setUmamiSite } from "../actions";
import { fixtureMode, getUmamiConnectionInfo, type UmamiConnectionInfo } from "../account";
import { listUmamiSites } from "../sites";
import { getUmamiSyncState } from "../sync";
import { UmamiAccessError, type UmamiSite } from "../types";

export type UmamiConnection = { state: "fixtures" } | { state: "not_connected" } | { state: "reauth"; account: UmamiConnectionInfo } | { state: "connected"; account: UmamiConnectionInfo };

export async function getUmamiConnection(): Promise<UmamiConnection> {
  if (fixtureMode()) return { state: "fixtures" };
  const account = await getUmamiConnectionInfo((await workspaceScope()).workspaceId);
  if (account?.status === "reauth_required") return { state: "reauth", account };
  if (account) return { state: "connected", account };
  return { state: "not_connected" };
}

const isUsable = (c: UmamiConnection) => c.state === "fixtures" || c.state === "connected";

/** "Umami Cloud" or the self-hosted server's address. */
export const umamiServerName = (account: Pick<UmamiConnectionInfo, "baseUrl">) => (account.baseUrl ? account.baseUrl.replace(/^https:\/\//, "") : "Umami Cloud");

/** The secret fields' shared settings: nothing on this page ever holds the saved credential, and password managers stay out. */
const SECRET = { autoComplete: "off", spellCheck: false, "data-1p-ignore": true, "data-lpignore": "true" } as const;

/** The form a credential is pasted into. It goes one way: nothing on this page ever holds the saved key or token. */
function ConnectForm({ again, server }: { again?: boolean; server?: string | null }) {
  return (
    // ph-no-capture: SEOpen's own product analytics stays off this form.
    <ActionForm action={connectUmami} className="ph-no-capture flex flex-col gap-3">
      <Label className="max-w-[36rem]">
        Server address
        <Input name="umamiServer" type="url" placeholder="Blank for Umami Cloud, or https://stats.example.com" defaultValue={server ?? ""} autoComplete="off" spellCheck={false} />
      </Label>
      <Label className="max-w-[36rem]">
        API key
        <Input name="umamiKey" type="password" {...SECRET} />
      </Label>
      <fieldset className="flex max-w-[36rem] flex-wrap gap-2">
        <legend className="mb-1 text-xs text-muted">Or, for a self-hosted server without API keys, the login you use there:</legend>
        <Label className="min-w-0 flex-[1_1_12rem]">
          Username
          <Input name="umamiUsername" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
        </Label>
        <Label className="min-w-0 flex-[1_1_12rem]">
          Password
          <Input name="umamiPassword" type="password" {...SECRET} />
        </Label>
      </fieldset>
      <div>
        <Button type="submit">{again ? "Reconnect Umami" : "Connect Umami"}</Button>
      </div>
    </ActionForm>
  );
}

/** What the page says about Umami before its numbers, since the panel sits at the end of the page. */
export function UmamiNotices({ project, connection }: { project: Project; connection: UmamiConnection }) {
  if (connection.state === "reauth" && project.umamiSite) {
    return (
      <div className="mb-4">
        <Callout tone="bad" title="Reconnect Umami">
          Umami stopped accepting this workspace&apos;s credential, so syncs are paused.{" "}
          <a href="#umami" className="text-accent hover:underline">
            Reconnect
          </a>
        </Callout>
      </div>
    );
  }
  return null;
}

/** The name of a project's Umami website, from the connection's list. Null when the list can't be read. */
export async function umamiSiteName(project: Project): Promise<string | null> {
  if (!project.umamiSite) return null;
  const sites = await listUmamiSites(project.workspaceId).catch(() => null);
  return sites?.find((s) => s.id === project.umamiSite)?.name ?? null;
}

/**
 * For a project still on Umami in a workspace the gate keeps closed: only a way to stop using it, since
 * nothing else about Umami can be set up there. The page shows this in place of the panel.
 */
export function UmamiStop({ project }: { project: Project }) {
  return (
    <Card id="umami" className="scroll-mt-4">
      <CardHeader title="Umami" description={`${project.name} reads its Analytics from Umami, which this workspace can't set up. You can stop using it and pick another source.`} />
      <CardBody className="text-sm">
        <ActionForm action={setUmamiSite.bind(null, project.id)}>
          <input type="hidden" name="umamiSite" value="" />
          <ConfirmSubmit variant="danger" question={`Stop using Umami for ${project.name}? Its stored Umami numbers are cleared.`} confirmLabel="Stop using Umami">
            Stop using Umami
          </ConfirmSubmit>
        </ActionForm>
      </CardBody>
    </Card>
  );
}

/** Umami as the project's Analytics source: connect, pick the website for this SEOpen project, or disconnect. */
export async function UmamiPanel({ project, connection }: { project: Project; connection: UmamiConnection }) {
  const timeZone = await currentTimeZone();
  let sites: UmamiSite[] | null = null;
  let listError: unknown = null;
  if (isUsable(connection)) {
    try {
      sites = await listUmamiSites((await workspaceScope()).workspaceId);
    } catch (e) {
      listError = e;
    }
  }
  const usingUmami = !!project.umamiSite;
  // The connection can be fine while the sync has lost this website. The sync row says what's wrong, so the way to fix it is here.
  const syncLostAccess = connection.state === "connected" && usingUmami && (await getUmamiSyncState(projectScope(project)))?.status === "reauth";
  const otherSource = project.ga4Property ? "GA4" : project.posthogProject ? "PostHog" : project.plausibleSite ? "Plausible" : null;
  // Saving clears the stored numbers of whichever source this replaces, so that's asked first.
  const replaces = usingUmami ? `Change this project's Umami website? Its stored Umami numbers are cleared and synced again.` : otherSource ? `Use Umami instead of ${otherSource} for ${project.name}? Its stored ${otherSource} numbers are cleared.` : null;
  const server = connection.state === "reauth" || connection.state === "connected" ? connection.account.baseUrl : null;

  return (
    <Card id="umami" className="scroll-mt-4">
      <CardHeader title="Umami" description="Visits from search per landing page from Umami Cloud or your own Umami server. SEOpen only reads your website list and these visits." />
      <CardBody className="flex flex-col gap-3 text-sm">
        {connection.state === "fixtures" && (
          <Callout tone="warn" title="Fixture data">
            SEOPEN_UMAMI_FIXTURES=1 is set, so the Umami websites and numbers here are generated test data.
          </Callout>
        )}
        {connection.state === "not_connected" && (
          <>
            <p className="max-w-[72ch] text-muted">
              Use Umami for this project. In Umami, open Settings, then API keys, create a key and paste it here. For your own server, enter its address too; it has to be on https at a public address. A self-hosted server without API keys can sign in with a username and password instead: SEOpen uses them once for a token and doesn&apos;t keep the password. SEOpen checks the connection, stores the key or token encrypted, and never shows it again.
            </p>
            <ConnectForm />
          </>
        )}
        {connection.state === "reauth" && (
          <>
            <Callout tone="bad" title="Reconnect needed">
              Umami stopped accepting the saved credential, usually because the key was deleted or the sign-in expired. Syncs are paused until you connect again.
            </Callout>
            <ConnectForm again server={server} />
          </>
        )}
        {connection.state === "connected" && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="good">Connected</Badge>
            <span>{umamiServerName(connection.account)}</span>
            <span className="text-muted">since {formatDateTime(connection.account.connectedAt, timeZone)}</span>
            <form action={disconnectUmami} className="ml-auto">
              <ConfirmSubmit variant="danger" question="Disconnect Umami for this workspace? SEOpen deletes its copy of the key or token and syncs stop. An API key keeps working in Umami until you delete it there." confirmLabel="Disconnect">
                Disconnect
              </ConfirmSubmit>
            </form>
          </div>
        )}
        {listError != null && <ApiError error={listError} />}
        {(listError instanceof UmamiAccessError || syncLostAccess) && <ConnectForm again server={server} />}
        {sites && (
          <ActionForm action={setUmamiSite.bind(null, project.id)} className="flex flex-wrap items-center gap-2">
            <Select name="umamiSite" defaultValue={project.umamiSite ?? ""} className="h-8 w-full max-w-80 text-xs" aria-label={`Umami website for ${project.name}`}>
              <option value="">{usingUmami ? "None (stop using Umami)" : "Choose an Umami website"}</option>
              {/* A reconnected credential may no longer list the website in use. */}
              {project.umamiSite && !sites.some((s) => s.id === project.umamiSite) && <option value={project.umamiSite}>{project.umamiSite} (no access)</option>}
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name && s.name !== s.domain ? `${s.name} · ${s.domain}` : s.domain}
                </option>
              ))}
            </Select>
            {replaces ? (
              <ConfirmSubmit question={replaces} confirmLabel={usingUmami ? "Save" : "Use Umami"}>
                {usingUmami ? "Save" : `Use for ${project.name}`}
              </ConfirmSubmit>
            ) : (
              <Button size="sm" variant="secondary" type="submit">
                {`Use for ${project.name}`}
              </Button>
            )}
            {!usingUmami && otherSource && <span className="text-xs text-muted">Replaces {otherSource} as this project&apos;s Analytics source.</span>}
          </ActionForm>
        )}
        {sites?.length === 0 && <p className="text-muted">This connection can&apos;t see any websites. Add the website in Umami, or connect a user or key that can read it.</p>}
      </CardBody>
    </Card>
  );
}
