import { ApiError } from "@/components/api-error";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { Select } from "@/components/ui/input";
import { formatDateTime } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, workspaceScope } from "@/lib/workspace/current";
import { ActionForm } from "@/components/ui/action-form";
import { disconnectPosthog, setPosthogProject } from "../actions";
import { fixtureMode, getPosthogAccount, type PosthogAccount } from "../account";
import { oauthAvailable } from "../oauth";
import { listPosthogProjects } from "../projects";
import { getPosthogSyncState } from "../sync";
import { PosthogAccessError, type PosthogProject } from "../types";

export type PosthogConnection =
  | { state: "fixtures" }
  | { state: "not_configured" }
  | { state: "not_connected" }
  | { state: "reauth"; account: PosthogAccount }
  | { state: "connected"; account: PosthogAccount };

export async function getPosthogConnection(): Promise<PosthogConnection> {
  if (fixtureMode()) return { state: "fixtures" };
  const account = await getPosthogAccount((await workspaceScope()).workspaceId);
  if (account?.status === "reauth_required") return { state: "reauth", account };
  if (account) return { state: "connected", account };
  return oauthAvailable() ? { state: "not_connected" } : { state: "not_configured" };
}

export const isPosthogUsable = (c: PosthogConnection) => c.state === "fixtures" || c.state === "connected";

/** The mapped project's name from the connection's project list, when it can be read. */
export async function posthogProjectName(project: Pick<Project, "posthogProject">): Promise<string | null> {
  if (!project.posthogProject) return null;
  try {
    const list = await listPosthogProjects((await workspaceScope()).workspaceId);
    return list.find((p) => String(p.id) === project.posthogProject)?.name ?? null;
  } catch {
    return null;
  }
}

const ERRORS: Record<string, string> = {
  not_configured: "PostHog sign-in needs SEOpen's https address, so it only works on a deploy served over https. Locally, set SEOPEN_POSTHOG_FIXTURES=1.",
  access_denied: "Consent was cancelled in PostHog. Connect again and approve SEOpen's access.",
  state_mismatch: "The sign-in took too long or came from another tab. Try again.",
  account_changed: "You switched SEOpen accounts while connecting, so nothing was connected. Try again.",
  bad_region: "Pick US Cloud or EU Cloud.",
  disconnect_failed: "PostHog couldn't be reached to revoke SEOpen's access, so it is still connected. Try Disconnect again.",
  token_exchange_failed: "PostHog didn't accept the sign-in. Try connecting again.",
  invalid_grant: "PostHog didn't accept the sign-in code. Try connecting again.",
};

/** The callback's error, in words. The value comes from the URL, so anything but a known message or a bare code gets a stock sentence. */
const errorText = (err: string) => (Object.hasOwn(ERRORS, err) ? ERRORS[err] : /^[a-z0-9_]{1,60}$/.test(err) ? `PostHog answered "${err}". Try connecting again.` : "The connection didn't finish. Try connecting again.");

function ConnectButtons({ again }: { again?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ButtonLink href="/api/posthog/connect?region=us" prefetch={false} size="sm">
        {again ? "Reconnect" : "Connect"} PostHog US Cloud
      </ButtonLink>
      <ButtonLink href="/api/posthog/connect?region=eu" prefetch={false} size="sm" variant="secondary">
        EU Cloud
      </ButtonLink>
    </div>
  );
}

/**
 * What the page says about PostHog before its numbers, since the panel sits at the end of the page.
 * `sp` carries ?posthog_connected=1 or ?posthog_error= from the callback.
 */
export function PosthogNotices({ project, connection, sp }: { project: Project; connection: PosthogConnection; sp: Record<string, string | string[] | undefined> }) {
  const err = typeof sp.posthog_error === "string" ? sp.posthog_error : null;
  const connected = sp.posthog_connected === "1" && isPosthogUsable(connection) && !project.posthogProject;
  const paused = connection.state === "reauth" && !!project.posthogProject;
  if (!err && !connected && !paused) return null;
  return (
    <div className="mb-4 flex flex-col gap-3">
      {err && (
        <Callout tone="bad" title="PostHog connection failed">
          {errorText(err)}
        </Callout>
      )}
      {connected && <Callout title="Connected">Pick the PostHog project for {project.name} in the PostHog section below, then the first sync starts.</Callout>}
      {paused && (
        <Callout tone="bad" title="Reconnect PostHog">
          PostHog stopped accepting SEOpen&apos;s access, so syncs are paused.{" "}
          <a href="#posthog" className="text-accent hover:underline">
            Reconnect
          </a>
        </Callout>
      )}
    </div>
  );
}

/** PostHog as the project's Analytics source: connect (one click per region), pick the PostHog project for this SEOpen project, or disconnect. */
export async function PosthogPanel({ project, connection }: { project: Project; connection: PosthogConnection }) {
  const timeZone = await currentTimeZone();
  let projects: PosthogProject[] | null = null;
  let listError: unknown = null;
  if (isPosthogUsable(connection)) {
    try {
      projects = await listPosthogProjects((await workspaceScope()).workspaceId);
    } catch (e) {
      listError = e;
    }
  }
  const usingPosthog = !!project.posthogProject;
  // The connection can be fine while the sync has lost this project. The sync row says to reconnect, so the way to do it is here.
  const syncLostAccess = connection.state === "connected" && usingPosthog && (await getPosthogSyncState(projectScope(project)))?.status === "reauth";
  // Saving clears the stored numbers of whichever source this replaces, so that's asked first.
  const replaces = usingPosthog ? `Change this project's PostHog source? Its stored PostHog numbers are cleared and synced again.` : project.ga4Property ? `Use PostHog instead of GA4 for ${project.name}? Its stored GA4 numbers are cleared.` : null;

  return (
    <Card id="posthog" className="scroll-mt-4">
      <CardHeader title="PostHog" description="Organic search sessions per landing page from your PostHog web analytics. Read-only: SEOpen can list projects and run queries, nothing else." />
      <CardBody className="flex flex-col gap-3 text-sm">
        {connection.state === "fixtures" && (
          <Callout tone="warn" title="Fixture data">
            SEOPEN_POSTHOG_FIXTURES=1 is set, so the PostHog projects and numbers here are generated test data.
          </Callout>
        )}
        {connection.state === "not_configured" && <p className="text-muted">{ERRORS.not_configured}</p>}
        {connection.state === "not_connected" && (
          <>
            <p className="text-muted">Use PostHog instead of GA4 for this project. Pick the cloud your PostHog account is on; the address you use is us.posthog.com or eu.posthog.com.</p>
            <ConnectButtons />
          </>
        )}
        {connection.state === "reauth" && (
          <>
            <Callout tone="bad" title="Reconnect needed">
              PostHog stopped accepting SEOpen&apos;s access (revoked, or the sign-in expired). Syncs are paused until you reconnect.
            </Callout>
            <ConnectButtons again />
          </>
        )}
        {connection.state === "connected" && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="good">Connected</Badge>
            <span>{connection.account.region === "eu" ? "EU Cloud" : "US Cloud"}</span>
            <span className="text-muted">since {formatDateTime(connection.account.connectedAt, timeZone)}</span>
            <form action={disconnectPosthog} className="ml-auto">
              <ConfirmSubmit variant="danger" question="Disconnect PostHog for this workspace? Syncs stop until you reconnect." confirmLabel="Disconnect">
                Disconnect
              </ConfirmSubmit>
            </form>
          </div>
        )}
        {listError != null && <ApiError error={listError} />}
        {(listError instanceof PosthogAccessError || syncLostAccess) && <ConnectButtons again />}
        {projects && (
          <ActionForm action={setPosthogProject.bind(null, project.id)} className="flex flex-wrap items-center gap-2">
            <Select name="posthogProject" defaultValue={project.posthogProject ?? ""} className="h-8 w-full max-w-80 text-xs" aria-label={`PostHog project for ${project.name}`}>
              <option value="">{usingPosthog ? "None (stop using PostHog)" : "Choose a PostHog project"}</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name} ({p.id})
                </option>
              ))}
            </Select>
            {replaces ? (
              <ConfirmSubmit question={replaces} confirmLabel={usingPosthog ? "Save" : "Use PostHog"}>
                {usingPosthog ? "Save" : `Use for ${project.name}`}
              </ConfirmSubmit>
            ) : (
              <Button size="sm" variant="secondary" type="submit">
                {`Use for ${project.name}`}
              </Button>
            )}
            {!usingPosthog && project.ga4Property && <span className="text-xs text-muted">Replaces GA4 property {project.ga4Property.replace(/^properties\//, "")} as this project&apos;s Analytics source.</span>}
          </ActionForm>
        )}
        {projects?.length === 0 && <p className="text-muted">This connection can&apos;t see any PostHog projects. Reconnect and grant access to the project you want.</p>}
      </CardBody>
    </Card>
  );
}
