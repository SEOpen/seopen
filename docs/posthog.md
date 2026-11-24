# PostHog as an Analytics source

A project's Analytics source is one of GA4, PostHog, Plausible or Umami (`docs/plausible.md`, `docs/umami.md`). PostHog fills the same table GA4 does (`ga4_landing_daily`), so the Analytics page, the dashboard card, the Search Console join and the MCP `analytics` tool work unchanged.

**Status:** built, with migration `0011_posthog_source`. The worker runs `posthog.sync`. It hasn't been tried against many real PostHog accounts yet. The OAuth flow needs an https address for SEOpen, so it only works on an https deployment (see "Local development" for working without one).

## Connecting

One click. On `/ga4`, the PostHog card has **Connect PostHog US Cloud** and **EU Cloud**. The user approves SEOpen in PostHog, picks which projects it may see, and comes back to pick the PostHog project for the SEOpen project.

- **Client:** PostHog's Client ID Metadata Document (CIMD) flow. The client_id is the URL of a JSON document SEOpen serves at `/api/posthog/client-metadata`, so there is nothing to register and no secret. The token endpoint auth method is `none`; PKCE (S256) protects the code.
- **Regions:** `https://us.posthog.com` and `https://eu.posthog.com`, each with `/oauth/authorize/`, `/oauth/token/` and `/oauth/revoke/`. PostHog has no documented way to find a user's region, so the user picks it.
- **Scopes:** `project:read` and `query:read`. Read-only: SEOpen lists projects and runs queries, nothing else.
- **Scoped teams:** the token response lists the projects the user granted (`scoped_teams`). When it is set, SEOpen reads only those; when empty, it lists every project the user can see.
- **Unverified app:** PostHog shows an "unverified application" notice on the consent screen for a client it hasn't verified. Verification is a request to PostHog support.
- **Tokens:** encrypted with `SEOPEN_SECRET_KEY` in `posthog_accounts`, one row per workspace. The access token refreshes when it has under 2 minutes left. A refused refresh, or a 401 from the API, marks the account `reauth_required`, pauses syncs and shows **Reconnect**.
- **Disconnect** revokes both tokens at PostHog first. If PostHog can't be reached the connection stays and the page says so.

Routes: `/api/posthog/connect?region=us|eu` sets a 10-minute encrypted cookie (state, PKCE verifier, region) and redirects to PostHog; `/api/posthog/callback` checks the state, exchanges the code, saves the account and records `module_activated` with `module: "posthog"`. The metadata route is public (`src/proxy.ts`).

## The query

HogQL through `POST /api/projects/:id/query/` (`src/modules/posthog/hogql.ts`): sessions from the `sessions` table where `$channel_type = 'Organic Search'`, grouped by day (`$start_timestamp`), `$entry_hostname` and `$entry_pathname`.

- **Sessions** is the session count; **engaged sessions** is the count that didn't bounce (`$is_bounce`). Key events and revenue are 0, and the PostHog view of `/ga4` hides those columns.
- Dates are validated as `YYYY-MM-DD` before they go into the query.
- PostHog caps a result at 50,000 rows. When a range hits the cap, SEOpen halves it and queries each half.
- Limits: 240 queries a minute, 10 s each. A 429 pauses the sync 15 minutes (an hour after 3 in a row).

## AI assistants

The Analytics page's AI assistants section and MCP `get_analytics` ask PostHog live, for the page's period (`sourceSessionsQuery` in `hogql.ts`): every session from `sessions`, grouped by `lower($entry_referring_domain)` and `lower($entry_utm_source)`, largest first, up to 10,000 groups. The referrer decides and the utm_source counts when there's no referrer (PostHog's `$direct`). The shared list in `src/lib/ai-referrers.ts` picks out the assistants. Nothing is stored.

## The sync

`posthog.sync` (`src/modules/posthog/jobs.ts`) runs daily at 07:40 for every project with `projects.posthog_project`, and on demand from **Sync now** and when a project is mapped.

- It uses the same planner as GA4: the last 3 days again each run, plus 30-day backfill chunks, up to 16 months.
- The newest day is yesterday in the PostHog project's timezone.
- State lives in `google_sync_state` with `source = 'posthog'`.
- A project remapped while a sync runs is skipped, so rows never land under the wrong source.

## Local development

CIMD needs an https origin, so locally set `SEOPEN_POSTHOG_FIXTURES=1`. The card then offers two fixture projects (ids 2001 and 2002) whose numbers are borrowed from the GA4 fixtures.

## Not built yet

- A trial claim for PostHog projects. GA4 properties are claimed per trial (`ga4Claim`) so one property can't run several trials; PostHog projects aren't.
- Verification of the OAuth client with PostHog.
