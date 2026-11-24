# Plausible as an Analytics source

A project's Analytics source is one of GA4, PostHog, Plausible or Umami. Plausible fills the same table the others do (`ga4_landing_daily`), so the Analytics page, the dashboard card, the Search Console join and the MCP `analytics` tool work unchanged. The fix reports also show its visits beside Search Console's clicks.

**Status:** built and tested against faked Plausible responses only. Not yet tried with a real Plausible account. Connecting is limited to the operator's own workspaces, the ones `isInternal` accepts (see [Who can use it](#who-can-use-it)). Plausible Cloud only. Umami, Cloud and self-hosted, is built (`docs/umami.md`), and its requests to a customer's server go through `safeFetch`'s guards. Self-hosted Plausible is a follow-up: `PLAUSIBLE_ORIGIN` in `src/modules/plausible/types.ts` is fixed, and would take the same guarded transport.

## Connecting

On `/ga4`, the Plausible card takes a pasted Stats API key, because Plausible has no OAuth for this. The customer creates the key in Plausible under Account settings, API Keys, New API Key, Stats API. Plausible shows it once. Then they pick the site from a list.

- **The plan.** Plausible makes the Stats API a Business plan feature. On a plan without it, or with a lapsed subscription, Plausible answers 402 and SEOpen says so plainly.
- **Scope.** A key belongs to one Plausible team and reads the sites that team owns. It isn't per site. A key from the wrong team can't see the site, so the empty list says to make it in the team that owns the site.
- **Checked before saving.** `checkPlausibleKey` lists the sites (`GET /api/v1/sites`), then runs a one-day query on the first (`POST /api/v2/query`), because the listing alone doesn't prove the Stats API is open to the key. Nothing is stored on a failure, and the message is ours, not Plausible's. A working key with no sites yet is saved.
- **The site.** The list comes from the key itself, and `setPlausibleSite` refuses a site that isn't on it. So a workspace can't map a site its own key can't read.
- **One connection per workspace,** as with PostHog. A second connect replaces the key.

## The key

Handled in these places and nowhere else:

| Where | What happens |
|---|---|
| The form in `ui/panel.tsx` | A `type="password"` field marked `ph-no-capture`. The page never holds the saved key, or any part of it. |
| `connectPlausible` in `actions.ts` | Read from the form, checked, saved. It isn't logged, and no error it returns repeats it. |
| `checkPlausibleKey` and `request` in `api.ts` | Sent as a bearer token to `https://plausible.io` only, with `redirect: "error"`. Any text Plausible sends back has the key taken out before it can reach an error or `last_error`. |
| `savePlausibleAccount` and `plausibleKey` in `account.ts` | Encrypted and decrypted with `src/lib/crypto.ts`, the helper the Google refresh tokens use. `api_key_enc` is the only place it's stored. |
| Reads for pages and Admin | `getPlausibleConnectionInfo` and Admin's own selects leave the key column out. |
| Export | `plausible_accounts` omits `apiKeyEnc` in `src/lib/workspace/export.ts`, and `export.db.test.ts` checks both the stored and plain forms. Only a workspace the gate has opened, or one holding an account or a mapped site, is offered the table or the `plausibleSite` column. |
| Disconnect | `disconnectPlausible` deletes the row. Plausible has no API to revoke a key, so the confirm says it keeps working there until the customer deletes it. Mapped projects keep what's stored, and their syncs say to reconnect. |
| Deleting a workspace | The foreign key's cascade takes the row in the delete transaction. There's nothing to call at Plausible. |

The key never goes into analytics events (`module_activated` carries `module: "plausible"` only) or MCP output.

## The query

`POST https://plausible.io/api/v2/query` with `Authorization: Bearer <key>` (`src/modules/plausible/query.ts`, documented at https://plausible.io/docs/stats-api):

- `metrics`: `visits`, `bounce_rate`
- `dimensions`: `time:day`, `visit:entry_page_hostname`, `visit:entry_page`
- `filters`: `["is", "visit:channel", ["Organic Search"]]`
- `date_range`: `[start, end]`, as `YYYY-MM-DD`, validated first
- `order_by`: the three dimensions ascending, so pages join up
- `pagination`: `limit` 10,000 (Plausible's default; its docs state no maximum), `offset` until a short page

`GET /api/v1/sites` reads `domain` and `timezone`, following `meta.after` (documented at https://plausible.io/docs/sites-api, and it works with a Stats API key). `GET /api/v1/sites/:site_id` reads one site's `timezone`.

**What the numbers are.** Sessions are Plausible's `visits`. Engaged sessions are the visits that didn't bounce, worked out from a whole-percent `bounce_rate`, so a large page's figure can be slightly off. Key events and revenue are 0, and the Plausible view of `/ga4` hides those columns as it does for PostHog. Imported stats are left out (`include.imports` defaults to false).

**What they count.** Plausible's Organic Search channel means the source is a known search site or the medium is organic (https://plausible.io/docs/top-referrers). So it covers engines beyond Google, and any link tagged with the medium organic, and it won't match Search Console's clicks. The Analytics page, the fix reports and MCP say this.

**Errors.** The Stats API docs don't list error responses. The handling comes from Plausible's public source (`lib/plausible_web/plugs/authorize_public_api.ex`), which a real account still has to confirm:

| Status | Means | SEOpen |
|---|---|---|
| 401 | A bad key, or a site the key can't read | Asks the site list which. A refused listing marks the account `reauth_required`; otherwise it's `PlausibleAccessError("site")` |
| 402 | No Stats API on the plan, or a locked site | `PlausibleAccessError("plan")`, no retry |
| 429 | Rate limit | `PlausibleQuotaError`, pauses 15 minutes, an hour after 3 in a row |

Rate limit: 600 requests an hour per key by default. A sync run is a handful of requests, so this doesn't change the schedule, though several projects share one key's limit.

## AI assistants

The Analytics page's AI assistants section and MCP `get_analytics` ask Plausible live, for the page's period (`sourceSessionsQuery` in `query.ts`): `visits` and `bounce_rate` by `visit:source`, with no channel filter, largest first, one page of 10,000. Plausible fills `visit:source` from a utm_source, source or ref tag, or else the referrer, and names sites it knows (it may show ChatGPT by name or as chatgpt.com), so the shared list in `src/lib/ai-referrers.ts` matches both names and hosts. Nothing is stored. It's one more Stats API request per page view, against the key's 600 an hour.

## The sync

`plausible.sync` (`src/modules/plausible/jobs.ts`) runs daily at 07:40, PostHog's time, for every project with `projects.plausible_site`, and on demand from **Sync now** and when a site is picked.

- It uses the same planner as GA4 and PostHog: the last 3 days again each run, plus 30-day backfill chunks, up to 16 months.
- The newest day is yesterday in the site's reporting time zone.
- State lives in `google_sync_state` with `source = 'plausible'`, so failures show in Admin, Health. A refused key shows under Connections too.
- A project remapped while a sync runs is skipped, so rows never land under the wrong source.
- These calls cost nothing and aren't in the DataForSEO ledger.

## The fix reports

`src/modules/fixes/visits.ts` adds Plausible's visits over the same days as each checkpoint's clicks, on `/fixes` and in `get_fix` as `plausible_visits`. They're read when the report shows, not stored with the result, so a site connected after a checkpoint still gets them from its backfill. A checkpoint is left out unless the sync reaches all its days and the site's stored history starts by its first day, because a day not synced, or from before the site was tracked, isn't a day with no visits. Fixes that read the whole site count the whole site.

The sentence only states numbers: "14 days before and after: Search Console clicks 40, then 47. Plausible organic visits 52, then 61." It makes no claim about the fix. The reports show where the plan policy allows them (`canSeeFixReports`), which is every workspace on a copy without plans.

Dates line up by label: the windows are Search Console days, and Plausible's are in the site's time zone. On a far-off zone the edges can differ by part of a day.

## Who can use it

Only a workspace on the `internal` plan can connect Plausible. The gate is there because a public privacy page has to name every service that receives customer data before customers can use it, and the copy doesn't name Plausible yet. On your own instance there are no plans, so every workspace you make can connect it (one that signed itself up can't).

The check is `plausibleOpen` in `src/modules/plausible/gate.ts`. For any other plan:

- `connectPlausible` and `setPlausibleSite` return "Plausible isn't available on this workspace." before any call to Plausible or any write.
- `/ga4` shows no Plausible card, connect form, site picker or reconnect notice, and its source-choice line says "GA4 or PostHog".

`/docs` and `/settings` look the same to every workspace (`docs/conventions.md`), so their copy doesn't name Plausible for anyone while this holds. The one exception is the export card on `/settings`, which lists a workspace's own tables: `exportTablesFor` shows `plausible_accounts` to a workspace the gate has opened, or one holding Plausible data, and to nobody else. The same goes for the palette's Docs entries and the MCP tool descriptions, which every client reads.

Sync, Admin, the fix report and MCP's results don't ask, because they only act on a project already mapped. Copy that only shows on a mapped project can name Plausible. `disconnectPlausible` doesn't ask either: deleting a key is always allowed. A workspace only holds a key or a mapping while its plan is `internal`, unless someone changes its plan by hand afterwards. It would keep syncing, with no card on `/ga4` to change that.

**To open Plausible to every plan:**

1. Delete `gate.ts`, `gate.db.test.ts` and the checks in `actions.ts` and `/ga4`, including the "GA4 or PostHog" branch, and `showsPlausible` in `src/lib/workspace/export.ts`, so `/settings` goes back to `EXPORT_TABLES`.
2. Put back the copy below.
3. Add Plausible to the in-app docs' Analytics page, and set `found("plausible")` in `nav-model.test.ts` to the docs page that names it.
4. Once open, it's gated as PostHog is: only a locked project is refused, so the Free plan can use it. The Free plan's wording names Search Console, GA4 and PostHog; decide whether it should name Plausible too.

| Where | Now | Then |
|---|---|---|
| Guide, Analytics section name, and the palette in `nav-model.ts` | Analytics (GA4 or PostHog) | Analytics (GA4, PostHog or Plausible) |
| Guide, Analytics purpose | Each project uses GA4 or PostHog, not both. | Each project uses one of GA4, PostHog or Plausible. |
| Guide, Analytics steps | (no step) | Plausible: in your Plausible account settings, open API Keys and create a Stats API key. Paste it on the Analytics page, then pick the site. The Stats API is on Plausible's Business plan. SEOpen stores the key encrypted and never shows it again. Sessions are Plausible's visits on its Organic Search channel, which covers any search site it knows and links tagged with the medium organic, so they won't match Search Console's clicks. Plausible Cloud only for now. |
| Guide, Analytics cost | Free (Google and PostHog APIs). | Free (Google, PostHog and Plausible APIs). |
| Guide, Analytics schedule | Daily at 07:20 (GA4) and 07:40 (PostHog). | Daily at 07:20 (GA4) and 07:40 (PostHog and Plausible). |
| Guide, the schedule list | PostHog sync | PostHog and Plausible syncs |
| Settings, delete workspace | disconnects Google and PostHog | disconnects Google, PostHog and Plausible |
| MCP `analytics` with no data | Connect Google Analytics or PostHog on the Analytics page. | Connect Google Analytics, PostHog or Plausible on the Analytics page. |

## Local development

Set `SEOPEN_PLAUSIBLE_FIXTURES=1`. On an `internal` workspace, the card then offers two fixture sites whose numbers are borrowed from the GA4 fixtures, with no key. With it unset the form calls the real Plausible, so a made-up key shows the refusal message.

## Not built yet

- Self-hosted Plausible and a customer-supplied base URL (Umami has both: `docs/umami.md`).
- A trial claim for Plausible sites, the same gap PostHog has.
- Visits in the summary lines ("Fixed 12 titles on Nov 18") and for projects on GA4 or PostHog.
