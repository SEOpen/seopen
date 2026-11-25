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
import type { Project } from "@/lib/projects";
import { disconnectGoogle, syncNow } from "../actions";
import { fixtureMode, getAccount, missingScopes, oauthConfigured, type GoogleAccount } from "../auth";
import { propertyName } from "../matching";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace, workspaceScope } from "@/lib/workspace/current";
import { getSyncState } from "../sync";
import { getPlausibleSyncState } from "@/modules/plausible/sync";
import { getUmamiSyncState } from "@/modules/umami/sync";
import { umamiSiteName } from "@/modules/umami/ui/panel";
import { getPosthogSyncState } from "@/modules/posthog/sync";
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
        title="Google account"
        description="Search Console is Google's free report of the searches that show your site and the clicks they bring. GA4 is Google Analytics. One Google connection reads both, and SEOpen can only read them, never change anything."
        actions={
          connection.state === "not_connected" || connection.state === "reauth" ? (
            <ButtonLink href="/api/google/connect" prefetch={false} size="sm">
              {connection.state === "reauth" ? "Reconnect Google" : "Connect Google"}
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
            Add a Google OAuth client to GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the env file, then restart SEOpen. docs/google.md has the steps.
          </Callout>
        )}
        {connection.state === "not_connected" && (
          <>
            <p className="text-muted">Not connected. Connect the Google account you use for Search Console or Google Analytics.</p>
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
              <ConfirmSubmit variant="danger" question="Disconnect this Google account? Syncs stop until you connect again." confirmLabel="Disconnect">
                Disconnect
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

/** Sync state for both sources, with backfill progress and a "Sync now" button. */
export async function SyncStatus({ project }: { project: Project }) {
  const [timeZone, ws] = await Promise.all([currentTimeZone(), currentWorkspace()]);
  const internal = isInternal(ws);
  const scope = projectScope(project);
  // Analytics comes from GA4, PostHog, Plausible or Umami; the row shows whichever the project uses.
  const [gsc, analytics] = await Promise.all([getSyncState(scope, "gsc"), project.umamiSite ? getUmamiSyncState(scope) : project.plausibleSite ? getPlausibleSyncState(scope) : project.posthogProject ? getPosthogSyncState(scope) : getSyncState(scope, "ga4")]);
  const umamiName = project.umamiSite ? await umamiSiteName(project) : null;
  const rows = [
    { label: "Search Console", property: project.gscProperty, s: gsc, reconnect: { href: "/api/google/connect", label: "Reconnect Google" } },
    project.umamiSite
      ? { label: "Umami", property: umamiName ?? `Website ${project.umamiSite}`, s: analytics, reconnect: { href: "/ga4#umami", label: "Reconnect Umami" } }
      : project.plausibleSite
      ? { label: "Plausible", property: project.plausibleSite, s: analytics, reconnect: { href: "/ga4#plausible", label: "Reconnect Plausible" } }
      : project.posthogProject
      ? { label: "PostHog", property: `Project ${project.posthogProject}`, s: analytics, reconnect: { href: "/ga4#posthog", label: "Reconnect PostHog" } }
      : { label: "GA4", property: project.ga4Property, s: analytics, reconnect: { href: "/api/google/connect", label: "Reconnect Google" } },
  ];
  return (
    <Card>
      <CardHeader
        title="Sync"
        description={`Daily at ${zonedJobTime("07:00", timeZone)}. Re-pulls the last few days and backfills up to 16 months of history, oldest first.`}
        actions={
          (project.gscProperty || project.ga4Property || project.posthogProject || project.plausibleSite || project.umamiSite) && (
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
            {rows.map(({ label, property, s, reconnect }) => {
              const detail = s && syncErrorDetail(s, internal);
              const total = s?.backfillStart && s.latestDate ? Math.max(daysBetween(s.backfillStart, s.latestDate), 1) : null;
              const done = s?.backfillDone ? total : s?.backfillCursor && s.backfillStart && total ? Math.max(daysBetween(s.backfillStart, s.backfillCursor), 0) : null;
              return (
                <tr key={label} className="border-t border-line first:border-t-0">
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap">{label}</td>
                  <td className="px-4 py-2.5 text-muted">{property ? propertyName(property) : "No property"}</td>
                  <td className="px-4 py-2.5">{s ? <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{STATUS_WORDS[s.status] ?? s.status}</Badge> : <Badge>Never run</Badge>}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {s && syncMessage(s.status, s.message)}
                    {detail && <div className="text-bad">{detail}</div>}
                    {s?.status === "reauth" && (
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}
