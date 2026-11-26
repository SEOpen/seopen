import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { ModuleTabs } from "@/components/ui/tabs";
import { isInternal } from "@/lib/billing/gates";
import { syncErrorDetail } from "@/lib/dataforseo/failure-copy";
import { formatDateTime, formatDateTimeZoned, formatNumber } from "@/lib/format";
import { zonedJobTime } from "@/lib/schedule";
import type { ActionResult } from "@/lib/action-result";
import type { Project } from "@/lib/projects";
import { disconnectGoogle, stopUsingGoogle, syncNow } from "../actions";
import { fixtureMode, getAccount, missingScopes, oauthConfigured, type GoogleAccount } from "../auth";
import { propertyName } from "../matching";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace, workspaceScope } from "@/lib/workspace/current";
import { getSyncState } from "../sync";
import { setPlausibleSite } from "@/modules/plausible/actions";
import { getPlausibleSyncState } from "@/modules/plausible/sync";
import { getPlausibleConnection } from "@/modules/plausible/ui/panel";
import { setUmamiSite } from "@/modules/umami/actions";
import { getUmamiSyncState } from "@/modules/umami/sync";
import { getUmamiConnection, umamiSiteName } from "@/modules/umami/ui/panel";
import { setPosthogProject } from "@/modules/posthog/actions";
import { getPosthogSyncState } from "@/modules/posthog/sync";
import { getPosthogConnection } from "@/modules/posthog/ui/panel";
import { daysBetween } from "../windowing";
import { STATUS_WORDS, syncMessage, syncThrough } from "./sync-row";

export const GSC_TABS = [
  { href: "/gsc", label: "Performance" },
  { href: "/gsc/queries", label: "Queries" },
  { href: "/gsc/pages", label: "Pages" },
  { href: "/gsc/opportunities", label: "Opportunities" },
  { href: "/gsc/countries-devices", label: "Countries & devices" },
  { href: "/gsc/indexing", label: "Indexing" },
  { href: "/gsc/inspect", label: "URL inspection" },
  { href: "/gsc/sitemaps", label: "Sitemaps" },
];

export function GscTabs() {
  return <ModuleTabs tabs={GSC_TABS} />;
}

export type Connection =
  | { state: "fixtures" }
  | { state: "not_configured" }
  | { state: "not_connected" }
  | { state: "reauth"; account: GoogleAccount }
  | { state: "connected"; account: GoogleAccount; missing: string[] };

export async function getConnection(): Promise<Connection> {
  if (fixtureMode()) return { state: "fixtures" };
  if (!oauthConfigured()) return { state: "not_configured" };
  const account = await getAccount((await workspaceScope()).workspaceId);
  if (!account) return { state: "not_connected" };
  if (account.status === "reauth_required") return { state: "reauth", account };
  return { state: "connected", account, missing: missingScopes(account) };
}

export const isUsable = (c: Connection) => c.state === "fixtures" || c.state === "connected";

const ERRORS: Record<string, string> = {
  not_configured: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty in the env file.",
  access_denied: "Consent was cancelled, or this Google account isn't allowed to use the app (add it as a test user while the app is in Testing).",
  state_mismatch: "The sign-in took too long or came from another tab. Try again.",
  account_changed: "You switched SEOpen accounts while connecting, so nothing was connected. Try again.",
  no_refresh_token: "Google didn't return a refresh token. Remove SEOpen at myaccount.google.com/permissions, then connect again.",
  disconnect_failed: "Google couldn't revoke SEOpen's access (network or Google error), so the account is still connected. Try Disconnect again, or remove SEOpen at myaccount.google.com/permissions.",
  token_exchange_failed: "The code exchange failed. Check the client secret and that the redirect URI is exactly http://127.0.0.1:4100/api/google/callback.",
};

/** The callback's error, in words. The value comes from the URL, so anything but a known message or a bare code gets a stock sentence. */
const errorText = (err: string) => (Object.hasOwn(ERRORS, err) ? ERRORS[err] : /^[a-z0-9_]{1,60}$/.test(err) ? `Google answered "${err}". Try connecting again.` : "The connection didn't finish. Try connecting again.");

/** Connect / reconnect / connected panel. `sp` carries ?connected=1 or ?google_error= from the callback. */
export async function ConnectionPanel({ connection, sp }: { connection: Connection; sp: Record<string, string | string[] | undefined> }) {
  const timeZone = await currentTimeZone();
  const err = typeof sp.google_error === "string" ? sp.google_error : null;
  return (
    <Card>
      <CardHeader
        title="Google: Search Console and Analytics"
        description="One sign-in connects both, and one Disconnect stops both. Search Console is Google's free report of the searches that show your site and the clicks they bring. GA4 is Google Analytics. SEOpen can only read them, never change anything."
        actions={
          connection.state === "not_connected" || connection.state === "reauth" ? (
            <ButtonLink href="/api/google/connect" prefetch={false} size="sm">
              {connection.state === "reauth" ? "Reconnect Google" : "Connect Search Console and Analytics"}
            </ButtonLink>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3 text-sm">
        {err && (
          <Callout tone="bad" title="Google connection failed">
            {errorText(err)}
          </Callout>
        )}
        {sp.connected === "1" && connection.state === "connected" && <Callout title="Connected">Pick a property for each project below, then the first sync starts.</Callout>}
        {connection.state === "fixtures" && (
          <Callout tone="warn" title="Fixture data">
            SEOPEN_GOOGLE_FIXTURES=1 is set, so every Google number on these pages is generated test data, not your traffic.
          </Callout>
        )}
        {connection.state === "not_configured" && (
          <Callout tone="warn" title="OAuth client missing">
            Add a Google OAuth client to GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the env file, then restart SEOpen (in Docker: docker compose up -d). docs/google.md has the steps.
          </Callout>
        )}
        {connection.state === "not_connected" && (
          <>
            <p className="text-muted">Not connected. Connect the Google account you use for Search Console or Google Analytics. SEOpen lists every property of either that the account can open, and syncs only the ones linked to a project.</p>
            <p className="text-muted">
              Don&apos;t have Search Console? It&apos;s free: add your site at{" "}
              <a href="https://search.google.com/search-console" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                search.google.com/search-console
              </a>{" "}
              and follow Google&apos;s steps to prove you own it. Everything else in SEOpen works without it.
            </p>
          </>
        )}
        {connection.state === "reauth" && (
          <Callout tone="bad" title="Reconnect needed">
            Google rejected the stored token for {connection.account.email} (revoked, expired, or issued while the app was in Testing). Syncs are paused until you reconnect.
          </Callout>
        )}
        {connection.state === "connected" && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="good">Connected</Badge>
            <span>{connection.account.email}</span>
            <span className="text-muted">since {formatDateTime(connection.account.connectedAt, timeZone)}</span>
            {connection.account.refreshTokenExpiresAt && (
              <Badge tone="warn">Time-limited access until {formatDateTimeZoned(connection.account.refreshTokenExpiresAt, timeZone)}</Badge>
            )}
            <form action={disconnectGoogle} className="ml-auto">
              <ConfirmSubmit variant="danger" question="Disconnect Search Console and Google Analytics for this workspace? Syncs stop until you connect again. Numbers already saved stay until you stop using them in Sync." confirmLabel="Disconnect both">
                Disconnect both
              </ConfirmSubmit>
            </form>
          </div>
        )}
        {connection.state === "connected" && connection.missing.length > 0 && (
          <Callout tone="warn" title="Some permissions weren't granted">
            Missing: {connection.missing.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ")}. Reconnect and tick every checkbox on Google&apos;s consent screen.{" "}
            <a href="/api/google/connect" className="text-accent hover:underline">
              Reconnect
            </a>
          </Callout>
        )}
      </CardBody>
    </Card>
  );
}

const STATUS_TONE: Record<string, "neutral" | "accent" | "good" | "warn" | "bad"> = {
  idle: "neutral",
  queued: "accent",
  running: "accent",
  ok: "good",
  quota: "warn",
  error: "bad",
  reauth: "bad",
};

/** Unlinks a source from the project and deletes what it synced, whether or not its account is still connected. */
function StopUsing({ source, project, action, field }: { source: string; project: Project; action: (formData: FormData) => Promise<ActionResult>; field?: string }) {
  return (
    <ActionForm action={action} align="end">
      {field && <input type="hidden" name={field} value="" />}
      <ConfirmSubmit variant="ghost" question={`Stop using ${source} for ${project.name}? Its saved ${source} numbers are deleted.`} confirmLabel="Stop using" aria-label={`Stop using ${source} for ${project.name}`}>
        Stop using
      </ConfirmSubmit>
    </ActionForm>
  );
}

const hasAccount = (c: { state: string }) => c.state !== "not_connected" && c.state !== "not_configured";

/**
 * Sync state for both sources, with backfill progress, a "Sync now" button and a way to stop using each.
 * A source whose account was disconnected says so: its stored state is from before, and can still read "Up to date".
 */
export async function SyncStatus({ project }: { project: Project }) {
  const [timeZone, ws] = await Promise.all([currentTimeZone(), currentWorkspace()]);
  const internal = isInternal(ws);
  const scope = projectScope(project);
  // Analytics comes from GA4, PostHog, Plausible or Umami; the row shows whichever the project uses.
  const [gsc, analytics] = await Promise.all([getSyncState(scope, "gsc"), project.umamiSite ? getUmamiSyncState(scope) : project.plausibleSite ? getPlausibleSyncState(scope) : project.posthogProject ? getPosthogSyncState(scope) : getSyncState(scope, "ga4")]);
  const [google, other, umamiName] = await Promise.all([
    getConnection(),
    project.umamiSite ? getUmamiConnection() : project.plausibleSite ? getPlausibleConnection() : project.posthogProject ? getPosthogConnection() : null,
    project.umamiSite ? umamiSiteName(project) : null,
  ]);
  const googleOn = hasAccount(google);
  const analyticsOn = other ? hasAccount(other) : googleOn;
  const reconnectGoogle = { href: "/api/google/connect", label: "Reconnect Google" };
  const rows = [
    { label: "Search Console", property: project.gscProperty, s: gsc, on: googleOn, reconnect: reconnectGoogle, stop: stopUsingGoogle.bind(null, project.id, "gsc") },
    project.umamiSite
      ? { label: "Umami", property: umamiName ?? `Website ${project.umamiSite}`, s: analytics, on: analyticsOn, reconnect: { href: "/ga4#umami", label: "Reconnect Umami" }, stop: setUmamiSite.bind(null, project.id), field: "umamiSite" }
      : project.plausibleSite
      ? { label: "Plausible", property: project.plausibleSite, s: analytics, on: analyticsOn, reconnect: { href: "/ga4#plausible", label: "Reconnect Plausible" }, stop: setPlausibleSite.bind(null, project.id), field: "plausibleSite" }
      : project.posthogProject
      ? { label: "PostHog", property: `Project ${project.posthogProject}`, s: analytics, on: analyticsOn, reconnect: { href: "/ga4#posthog", label: "Reconnect PostHog" }, stop: setPosthogProject.bind(null, project.id), field: "posthogProject" }
      : { label: "GA4", property: project.ga4Property, s: analytics, on: analyticsOn, reconnect: reconnectGoogle, stop: stopUsingGoogle.bind(null, project.id, "ga4") },
  ];
  return (
    <Card>
      <CardHeader
        title="Sync"
        description={`Daily at ${zonedJobTime("07:00", timeZone)}. Re-pulls the last few days and backfills up to 16 months of history, oldest first.`}
        actions={
          rows.some((r) => r.property && r.on) && (
            <form action={syncNow.bind(null, project.id)}>
              <Button variant="secondary" size="sm" type="submit">
                Sync now
              </Button>
            </form>
          )
        }
      />
      <CardBody className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <tbody>
            {rows.map(({ label, property, s, on, reconnect, stop, field }) => {
              const off = !!property && !on;
              const detail = s && !off && syncErrorDetail(s, internal);
              const total = s?.backfillStart && s.latestDate ? Math.max(daysBetween(s.backfillStart, s.latestDate), 1) : null;
              const done = s?.backfillDone ? total : s?.backfillCursor && s.backfillStart && total ? Math.max(daysBetween(s.backfillStart, s.backfillCursor), 0) : null;
              return (
                <tr key={label} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap">{label}</td>
                  <td className="px-4 py-2.5 text-muted">{property ? propertyName(property) : "No property"}</td>
                  <td className="px-4 py-2.5">{off ? <Badge tone="warn">Disconnected</Badge> : s ? <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{STATUS_WORDS[s.status] ?? s.status}</Badge> : <Badge>Never run</Badge>}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {off ? "Nothing new syncs. The numbers saved before are kept until you stop using it." : s && syncMessage(s.status, s.message)}
                    {detail && <div className="text-bad">{detail}</div>}
                    {!off && s?.status === "reauth" && (
                      <a href={reconnect.href} className="block text-accent hover:underline">
                        {reconnect.label}
                      </a>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted whitespace-nowrap">
                    {total && done != null && !s?.backfillDone ? `History ${Math.min(100, Math.round((done / total) * 100))}% loaded` : s?.latestDate ? syncThrough(s.latestDate) : ""}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted whitespace-nowrap">
                    {s?.lastSuccessAt ? `Synced ${formatDateTime(s.lastSuccessAt, timeZone)}` : ""}
                    {s?.rowsWritten ? ` · ${formatNumber(s.rowsWritten)} rows` : ""}
                  </td>
                  <td className="px-4 py-2.5 text-right">{property && <StopUsing source={label} project={project} action={stop} field={field} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}
