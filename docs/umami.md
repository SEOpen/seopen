# Umami as an Analytics source

A project's Analytics source is one of GA4, PostHog, Plausible or Umami. Umami fills the same table the others do (`ga4_landing_daily`), so the Analytics page, the dashboard card, the Search Console join and the MCP `analytics` tool work unchanged. The fix reports show its visits beside Search Console's clicks, as they do Plausible's.

**Status:** built and tested against faked Umami responses only. Not yet tried with a real Umami Cloud account or a real self-hosted server. Connecting is limited to the operator's own workspaces, the ones `isInternal` accepts (see [Who can use it](#who-can-use-it)). Both Umami Cloud and self-hosted Umami work. Self-hosted Plausible is still not built (`docs/plausible.md`).

Module: `src/modules/umami/`. Schema: `src/db/schema/umami.ts`, migration `drizzle/0033_umami_source.sql` (`umami_accounts` and `projects.umami_site`).

## Sources

The API as built comes from Umami's docs, read on 2026-11-11 (the `umami.is/docs` links redirect to `docs.umami.is`):

- https://docs.umami.is/docs/api: Cloud's API is at `https://api.umami.is/v1`. A self-hosted server's is at its address plus `/api`.
- https://docs.umami.is/docs/api/authentication: API keys are the recommended method, created under Settings, API keys, and shown once. A self-hosted server also takes `POST /api/auth/login` with `{ username, password }`, which answers `{ token, user }`, or `{ requiresTwoFactor, partialToken }` when two-factor sign-in is on. Cloud takes API keys only.
- https://docs.umami.is/docs/cloud/api-key: `Authorization: Bearer <api-key>`, and a limit of 50 calls every 15 seconds per key. Earlier versions of that page used an `x-umami-api-key` header instead, so Cloud requests carry both.
- https://docs.umami.is/docs/api-reference/list-websites: `GET /websites` with `page`, `pageSize` and `includeTeams`, answering `{ data, count, page, pageSize }`. A website has `id`, `name` and `domain`, and no time zone.
- https://docs.umami.is/docs/api-reference/get-website: `GET /websites/:websiteId`.
- https://docs.umami.is/docs/api-reference/get-website-expanded-metrics: `GET /websites/:websiteId/metrics/expanded`, answering `[{ name, pageviews, visitors, visits, bounces, totaltime }]`.
- https://docs.umami.is/docs/api-reference/get-website-metrics and get-website-stats: used only by the filter check below.

Three things the docs don't cover come from Umami's public source (github.com/umami-software/umami, `master`, read the same day), and a real server still has to confirm them:

- **The regex operator.** Filter values can carry an operator prefix (`OPERATORS` in `src/lib/constants.ts`, parsed in `src/lib/params.ts`). SEOpen uses `re.` (regex) on `referrer`. The docs list the filter names, not the operators.
- **The search sites.** `SEARCH_DOMAINS` in `src/lib/constants.ts`: baidu.com, bing.com, duckduckgo.com, ecosia.org, google., msn.com, search.brave.com, yandex. That's the referrer half of Umami's own Organic Search channel (`src/queries/sql/getChannelMetrics.ts`).
- **What an entry row counts.** `getPageviewExpandedMetrics` files each visit under its first page view, and `visits` counts distinct visits, so a row is the visits that began on that path.

## Connecting

On `/ga4`, the Umami card takes:

- **Server address.** Blank for Umami Cloud. For a self-hosted server, its address, with a path if it's mounted under one. `normalizeUmamiServer` in `server.ts` keeps it only if it's `https` on the standard port, with no login in it, at a public hostname under a real domain suffix (`normalizeHost`, the free tools' check). An IP address, `localhost`, an intranet name, plain `http` or a port like `:3000` is refused before anything is sent. `cloud.umami.is` and `api.umami.is` connect as Cloud.
- **API key.** The customer creates it in Umami under Settings, API keys.
- **Or a username and password,** for a self-hosted server without API keys. `loginUmami` posts them once to `/api/auth/login` and keeps only the token. The password is never stored or logged. A user with two-factor sign-in is told to use an API key.

Then `checkUmami` lists the websites (`GET /websites?includeTeams=true`, following pages). For the first website it runs the filter check: when the last 30 days list a search site as a referrer, the same 30 days filtered by SEOpen's search filter must find visits. A server that doesn't understand the filter matches nothing, so without the check a too-old server would look like a site with no search traffic. Nothing is stored on a failure, and the message is ours, not Umami's. A working credential with no websites yet is saved.

The website list comes from the connection itself, and `setUmamiSite` refuses a website that isn't on it. One connection per workspace, as with PostHog and Plausible. A second connect replaces it.

## Requests to a customer's server

A self-hosted address is typed by the customer, so its requests go through `safeFetch` (`src/lib/web/fetch.ts`), the shared fetch the free tools also use, which this work extended with a method, headers and a body:

- Every connection is made to an address checked after DNS, inside the socket's own lookup, so a rebinding DNS answer can't swap in a private address between the check and the connect.
- A request with headers or a body follows no redirect, so a credential can't be carried to another address. A redirect comes back as a refused answer.
- One 30-second deadline per request, however slowly the server sends, and bodies over 5 MB are refused.
- A server that can't be reached raises `UmamiUnreachableError` with a reason in plain words (not in DNS, private address, timed out, refused, bad certificate).

Umami Cloud's requests use plain `fetch` to the fixed `https://api.umami.is/v1`, with `redirect: "error"` and the same timeout, like Plausible's.

## The credential

Handled in these places and nowhere else:

| Where | What happens |
|---|---|
| The form in `ui/panel.tsx` | `type="password"` fields in a form marked `ph-no-capture`. The page never holds the saved credential. |
| `connectUmami` in `actions.ts` | Read from the form, checked, saved. It isn't logged, and no error it returns repeats it. |
| `umamiClient` and `loginUmami` in `api.ts` | Sent as a bearer token to the connection's own API root only. Any text Umami sends back has the credential taken out before it can reach an error or `last_error`. Failures log a status or an error name, never Umami's words. |
| `saveUmamiAccount` and `umamiCredential` in `account.ts` | Encrypted and decrypted with `src/lib/crypto.ts` (AES-256-GCM), the helper the Google refresh tokens and the Plausible key use. `credential_enc` is the only place it's stored. |
| Reads for pages and Admin | `getUmamiConnectionInfo` and Admin's own selects leave the credential column out. |
| Export | `umami_accounts` omits `credentialEnc` in `src/lib/workspace/export.ts`, and `export.db.test.ts` checks both the stored and plain forms. The server address and the auth type (`api_key` or `login`) are exported. Only a workspace the gate has opened, or one holding an account or a mapped website, is offered the table or the `umamiSite` column. |
| Disconnect | `disconnectUmami` deletes the row. SEOpen can't revoke a key at Umami, so the confirm says it keeps working there until the customer deletes it. |
| Deleting a workspace | The foreign key's cascade takes the row in the delete transaction. |

The credential never goes into analytics events (`module_activated` carries `module: "umami"` only) or MCP output.

A login token can stop working (an expired session, a changed password). Umami then answers 401, the connection goes to `reauth_required`, and the card asks to connect again.

## The query

Umami's API has no channel filter and no daily breakdown of entry pages. So each day is its own pair of requests (`query.ts`):

`GET <root>/websites/:websiteId/metrics/expanded` with

- `type=entry`
- `startAt` and `endAt`: the UTC day in milliseconds, both inclusive, and `timezone=UTC`
- `referrer=re.(^|\.)(baidu\.com|bing\.com|duckduckgo\.com|ecosia\.org|google\.[a-z.]+|msn\.com|search\.brave\.com|yandex\.[a-z.]+)$`: visits that came from one of Umami's search sites
- `limit=500` and `offset`, until a short page
- the second request adds `excludeBounce=1` ("exclude visits with only one pageview")

**What the numbers are.** Sessions are Umami's `visits` per entry path. Engaged sessions are the visits that weren't bounces, from the second request. Umami reports a path without its host, so every row is filed under the website's `domain`. Key events and revenue are 0, and `/ga4` hides those columns as it does for PostHog and Plausible.

**What they count.** Visits that arrived from a search site, so engines beyond Google, and they won't match Search Console's clicks. Two differences from Umami's own Organic Search channel: links tagged with the medium organic aren't counted, and a paid search click (a `gclid`) is. The Analytics page, the fix reports and MCP say what's counted.

**Days are UTC,** because Umami keeps no time zone per website. Search Console's days are Pacific, so a fix report's edges can differ by part of a day.

**Errors.**

| Status | Means | SEOpen |
|---|---|---|
| 401 | A bad credential, or a website it can't read | Asks the website list which. A refused listing marks the account `reauth_required`; otherwise it's `UmamiAccessError` |
| 403, 404, or a null website | No access to the website, or it's gone | `UmamiAccessError`, no retry |
| 429 | Rate limit | `UmamiQuotaError`, pauses 15 minutes, an hour after 3 in a row |
| Not JSON | The address isn't an Umami API | Refused at connect |
| Unreachable | Self-hosted server down, private, refused | `UmamiUnreachableError`; the job retries |

## AI assistants

The Analytics page's AI assistants section and MCP `get_analytics` ask Umami live, for the page's period (`sourceParams` in `query.ts`): `GET <root>/websites/:websiteId/metrics/expanded` with `type=referrer`, the range's UTC days, and `limit=500` pages, up to 4. Engaged visits are `visits` minus `bounces`. The shared list in `src/lib/ai-referrers.ts` picks out the assistants by referrer domain. Umami's referrer report carries no utm_source, so a link tagged `utm_source=chatgpt.com` that sent no referrer isn't counted; the page and MCP say so. Nothing is stored.

## The sync

`umami.sync` (`src/modules/umami/jobs.ts`) runs daily at 07:40, with PostHog and Plausible, for every project with `projects.umami_site`, and on demand from **Sync now** and when a website is picked.

- The same planner as the other sources: the last 3 days again each run, then backfill a week at a time, 28 days a run, re-queued 30 seconds later until 16 months are in.
- A run is about 62 requests (two per day), spaced 320 ms apart to stay inside Cloud's 50 calls every 15 seconds, so about 20 seconds. Several projects on one key share that limit, and a 429 backs off.
- The newest day is yesterday in UTC.
- State lives in `google_sync_state` with `source = 'umami'`, so failures show in Admin, Health. A refused credential shows under Connections too.
- A project remapped while a sync runs is skipped, so rows never land under the wrong source.
- These calls cost nothing and aren't in the DataForSEO ledger.

## The fix reports

`src/modules/fixes/visits.ts` reads Umami's visits the way it reads Plausible's (`organicVisits` picks whichever the project uses). On `/fixes` the sentence says "Umami organic visits", with its own meaning line (`UMAMI_VISITS_MEANING` in `results.ts`), and `get_fix` returns them as `umami_visits`. The same coverage rule applies: a checkpoint shows only when the sync reaches all its days and the stored history starts by its first.

## Who can use it

Only a workspace on the `internal` plan can connect Umami. The gate is there because a public privacy page has to name every service that receives customer data before customers can use it, and the copy doesn't name Umami yet. For a self-hosted Umami server, Umami isn't a sub-processor (the customer runs it), but the privacy page still has to say what SEOpen reads and stores. On your own instance there are no plans, so every workspace you make can connect it (one that signed itself up can't).

The check is `umamiOpen` in `src/modules/umami/gate.ts`. For any other plan:

- `connectUmami` and `setUmamiSite` return "Umami isn't available on this workspace." before any request or write.
- `/ga4` shows no Umami card, connect form, website picker or reconnect notice, and its source-choice line doesn't name Umami.
- The new project form's Analytics switch doesn't offer Umami.

`/docs`, `/settings`, the palette and the MCP tool descriptions don't name Umami for anyone while this holds. The export card names `umami_accounts` only to a workspace the gate has opened or one holding Umami data. Sync, Admin, the fix report and MCP's results don't ask, because they only act on a project already mapped, and copy that only shows on a mapped project can name Umami. `disconnectUmami` doesn't ask either.

**To open Umami to every plan:**

1. Delete `gate.ts`, the checks in `actions.ts`, `/ga4` and `src/modules/analytics-source/choices.ts`, and `showsUmami` in `src/lib/workspace/export.ts`.
2. Add Umami to the Guide's Analytics section and schedule list, the palette in `nav-model.ts`, the workspace delete copy on `/settings`, and MCP's "no data" message, as `docs/plausible.md` lists for Plausible.
3. Once open, gate it as PostHog is: only a locked project is refused.

## Local development

Set `SEOPEN_UMAMI_FIXTURES=1`. On an `internal` workspace, the card then offers two fixture websites whose numbers are borrowed from the GA4 fixtures, with no credential. With it unset the form calls the real Umami, so a made-up key shows the refusal message.

## Tests

- `src/modules/umami/api.test.ts`: the address rules, both transports' refusals (Cloud's fixed host, a private self-hosted address), the query and its parsing, the search filter against Umami's list, the connection check and its filter check, paging, login and two-factor, the error mapping, credential scrubbing and request spacing. All against faked responses.
- `src/modules/umami/umami.db.test.ts`, against `seopen_test`: the gate (actions refuse before any request, `/ga4` shows nothing to a workspace `umamiOpen` refuses), a Cloud key stored encrypted, a self-hosted login through `safeFetch` that keeps the token and never the password, private and plain-http servers refused, one source at a time with Plausible and GA4, the sync filling the shared table, a refused credential reaching Admin, a remap mid-sync, and the fix report's `umami_visits`.
- `src/lib/workspace/export.db.test.ts` and `src/db/schema/tenancy.test.ts`: the credential stays out of the download, and the row goes with its workspace.

## Not built yet

- A trial claim for Umami websites, the same gap PostHog and Plausible have.
- Counting links tagged with the medium organic, as Umami's own channel does. It would need a second filter joined with `match=any`, which Umami applies to every filter at once.
- A per-website time zone: Umami has none to read.
