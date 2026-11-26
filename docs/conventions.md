# SEOpen conventions

These rules were written for the five parallel module builds (2026-10-29). They still apply to any change: the ownership table says where a module's code lives, and the shared files below are where cross-module changes go. Edit shared files deliberately and run the full checks afterwards.

Read this and the doc for your module before writing code:
- `docs/dataforseo.md`: endpoints, costs, cache lifetimes, status codes, gotchas
- `docs/google.md`: OAuth and the Search Console and GA4 APIs
- `docs/posthog.md`: PostHog as an Analytics source
- `docs/plausible.md`: Plausible as an Analytics source
- `docs/umami.md`: Umami (Cloud and self-hosted) as an Analytics source

## Running it

```bash
pnpm dev          # http://127.0.0.1:4100
pnpm worker:dev   # background jobs (pg-boss), restarts on change
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # all four must pass before you finish
```

In production the web app and the worker run as separate processes against one Postgres database. The worker applies new migrations when it starts, and the web app can serve new code before that, so a schema change must work with the previous deploy's code for the minute in between (see "Shipping a migration" below). Never run a local worker against the production database.

Locally you need Postgres 17 with two databases: `seopen` for dev and `seopen_test` for tests. Each git worktree's suite uses its own `seopen_test_<folder>_<hash>`, made on its first run (`src/db/test-database.ts`); drop old ones with `dropdb` when the worktree goes. `pnpm build` fails in a git worktree nested inside the checkout (Turbopack can't find `next/package.json` from there), so build from the main checkout. Secrets are in `.env.local`, which is git-ignored (`.env.example` lists them); production secrets belong in your host's secret settings. Never print or commit secrets.

Next.js is **16.4 with Cache Components on**, and its APIs differ from older versions. Check `node_modules/next/dist/docs/` before relying on memory. The rules that matter here:
- `params` and `searchParams` are Promises; use the `PageProps<"/route">` helper type.
- `export const dynamic`, `revalidate` and `runtime` are errors under Cache Components. Don't add them.
- Data loads on every request. The `(app)/loading.tsx` boundary wraps pages. Wrap slow sections of a page in their own `<Suspense>`.
- After a mutation in a Server Action, call `refresh()` from `next/cache` (or `redirect`).
- Middleware is called `proxy.ts` now. `src/proxy.ts` is the sign-in gate for the app: every app page and API route needs a Better Auth session (`src/lib/auth/`), locally too. Server Actions and API routes also call `requireSession()` themselves. The marketing site, when there is one, is public; see "Hosts" below.
- The dev server logs "encountered uncached data during prerendering or a navigation". It is a known dev-only warning and never fails the build. Ignore it.

## Hosts

The app can run on its own host, or beside a public marketing site on another host (`SEOPEN_SITE_HOST` and `SEOPEN_APP_HOST`). The marketing site isn't part of this tree.

- **Routing.** `src/lib/hosts.ts` lists the app's path prefixes (`APP_PREFIXES`). A new app route needs its prefix added there (`src/lib/hosts.test.ts` checks the folders). On the app host, non-app paths redirect to the site, and every response carries `X-Robots-Tag: noindex`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` (`headers()` in `next.config.ts`).
- **Built colours.** `pnpm css:check` runs at the end of `pnpm build` and fails it if a colour token in `src/app/globals.css` isn't in the built stylesheet with the same value. That most likely means a stale build cache: rebuild with the cache off. It only compares hex colours, so a redesign still needs a look in a browser. It needs a build to read, so it isn't part of `pnpm test`.

## Analytics

PostHog, on the free plan with no paid add-ons. Code: `src/lib/analytics/`.

- **Off without a key.** `NEXT_PUBLIC_POSTHOG_KEY` unset (local dev, tests, previews without it) means no script and no server events. `NEXT_PUBLIC_POSTHOG_HOST` picks US (`https://us.i.posthog.com`, the default) or EU Cloud. Tests never send, even with a key in `.env.local`.
- **Browser.** `PostHogClient` (`src/components/analytics/`) is mounted by the `(app)` layout only. It identifies the Better Auth user id, registers `workspace_id` and `plan` on every event, and sets the `workspace` group. It sends pageviews, page leaves and autocapture; Do Not Track turns it off. Its id lives in localStorage (`persistence: "localStorage"`), so there's no analytics cookie, and it expires the cookie older versions set.
- **Nothing from the page reaches PostHog.** The app shows customers' domains, keywords and Google data, so: autocapture masks all text and attributes; referrers and campaign tags aren't kept; session replay, heatmaps, rage and dead clicks, web vitals, exception and console capture, surveys, product tours, web experiments and feature flags are off; flags off means PostHog's remote config never loads, so none of those can be turned on from PostHog's side; and no external PostHog script loads (which also means no toolbar). Last, `before_send` runs `sanitizeEvent` (`src/lib/analytics/sanitize.ts`), an allowlist: only six events and the listed properties go out, URLs lose their query and hash, path segments that aren't plain slugs become `:redacted`, and autocapture's elements are cut to tag names and positions. A property a posthog-js upgrade adds is dropped until someone lists it, so check `sanitize.ts` when an upgrade seems to lose data, and never list one that can carry page text or a URL query.
- **Proxy.** The browser posts to `/ingest`, which `next.config.ts` rewrites to PostHog, so ad blockers don't drop events. `/ingest` is in `APP_PREFIXES`, and `src/proxy.ts` lets it through without a session, on every host, passing on only the headers PostHog needs (`RELAY_HEADERS`): no cookies, no `Authorization`, and nothing a load balancer or CDN in front of the app added for the app alone. `skipTrailingSlashRedirect` is on because PostHog's paths end in `/`; the first redirect in `next.config.ts` puts the trailing-slash redirect back for every other path.
- **Server events** go through `track()` (`server.ts`), which sends after the response and never throws. The distinct id is the Better Auth user id, as in the browser.
- **No emails or domains** in properties, browser or server: ids, plan names, counts and module keys only. The waitlist event is anonymous (a random id, no person profile) and carries no email, site or referrer.
- **Groups.** Group analytics is a paid add-on, so every event also carries `workspace_id` as a plain property. Break funnels down by it, or aggregate them by it with a HogQL expression. The `workspace` group is there for the day the add-on is worth it.

| Event | Sent from | Properties |
|---|---|---|
| `user_signed_up` | Better Auth's `user.create.after` hook (`src/lib/auth/index.ts`) | none |
| `project_created` | `createProjectOp` (the form and the MCP `create_project` tool); `importFromSearchConsole` | `project_id`, `source` (`form`, `mcp` or `search_console`), `competitors` |
| `project_deleted` | `deleteProjectOp` (the Delete project form in an archived project's Settings; no MCP tool) | `project_id` |
| `workspace_deleted` | `deleteWorkspaceOp` (the Delete this workspace form on `/settings`), `deleteWorkspaceAsAdminOp` and `deleteUserAsAdminOp` (the Delete forms in Admin); no MCP tool | `by` (`owner` or `admin`) |
| `module_activated` | `module: "gsc"`: the Google OAuth callback, on every successful connection. `posthog`: the PostHog OAuth callback, on every successful connection. `plausible`: `connectPlausible`, on every key Plausible accepts. `umami`: `connectUmami`, on every credential Umami accepts. `rank`: the first keywords added to a project. `audit`: a project's first crawl. `ai`: the first prompts added to a project | `module`, `project_id` (not for `gsc`), plus `keywords`, `max_pages` or `prompts` and `platforms` |
| `api_key_created` | `createApiKeyAction` (MCP (`/agents`)) | `write` (the key can make changes), `research` (the key can spend research credits) |
| `fixes_applied` | `markFixesApplied` (the MCP `mark_fix_applied` tool and the Fixes page) | `project_id`, `count`, `via` (`mcp` or `app`) |
| `fixes_dismissed` | `dismissFixes` (the MCP `dismiss_fix` tool and the Fixes page) | `project_id`, `count`, `via` |
| `setup_applied` | `applySetupOp` (the guided setup's Apply, `/projects/[id]/setup`) | `project_id`, `competitors`, `keywords`, `prompts`, `checks`, `failed_steps` |
| `waitlist_joined` | `joinWaitlist`, the marketing site's server action (not in this tree), once per new address (a repeat sign-up updates the row and sends nothing) | `heard_from`, `utm_source`, `from_path`, `has_site` |

Every event with a workspace also has `workspace_id`. A new event gets a name in `AnalyticsEvent` and a row here. A hosted service's billing can send events of its own, named in `AnalyticsEvent` and described with that billing code. Rank and AI count as set up when their first keywords or prompts are added, because the checks after that run on a schedule from the worker, which has no signed-in user.

## AI agents (MCP)

`POST /api/mcp` is a stateless MCP server (`@modelcontextprotocol/server` v2, JSON responses, 2026-07-28 and 2025-era clients). Code: `src/lib/mcp/`.

- **Auth:** a workspace API key (`seopen_…`) as a bearer token, made on the MCP page (`/agents`). `verifyApiKey()` (`keys.ts`) checks it on every call, including the creator's membership and the workspace's status. The proxy lets `/api/mcp` through without a session; the route never reads cookies.
- **Tools** (`server.ts`, data in `data.ts`) get the key's workspace, never `currentWorkspace()`. A project comes from `resolveProject(ws, ref)` (id, domain or name, inside the workspace). Every tool has a `title` and annotations; a refusal the agent should read is a `ToolError`.
- Read tools call module query functions and the dashboard loaders (`DASHBOARD_MODULES`, `pickHighlights`), so a module change that alters a loader's data shape shows up in `get_overview`. Run `src/lib/mcp/mcp.db.test.ts` after changing one.
- **Write tools** (`write-tools.ts`) are registered only for a key with the `write` scope (`canWrite()` in `keys.ts`). They call the shared ops, never module internals directly, and preview unless `confirm: true`. A research step quotes credits and needs `max_credits` and a key that also has the `research` scope (`canResearch()`); a write-only key gets the quote with `NO_RESEARCH` as its `next`, and `add_local_business` needs `weekly: false`. No tool deletes anything.
- **Limits and spend:** every request counts against the key's 120 a minute (`consumeLimit(…, "requests")` in `handler.ts`), every confirmed change against its 30 an hour (`counted()` in `write-tools.ts` and `fix-tools.ts`), and every paid research lookup against its 60 an hour (`research-tools.ts`). Tool bodies run inside `withBillingContext({ source: "mcp" })`, so paid calls, and jobs enqueued meanwhile, land in the ledger with `source = 'mcp'`. A job payload's `source` key is reserved for this.
- **Fix loop** (`src/modules/fixes/`): `list_fixes` and `get_fix` are for every key; `mark_fix_applied`, `record_change` (a change with no fix id, stored as a `manual` record), `verify_fix` and `dismiss_fix` need `write`. `verify_fix` has no preview, because it changes nothing on the site and only notes what it saw. Before and after reports are hidden on Free (`canSeeFixReports`) but measured for everyone.
- **Ops layer:** a change the app and MCP both make lives once, as a session-free function in `src/modules/<key>/ops.ts` (or `src/lib/ops/projects.ts`) taking a scope, an `Actor` (`userId`, `source`) and `{ dryRun }`. It runs every gate and throws `OpError` with a message written for the user. The Server Action adds `requireSession()`, `refresh()` and redirects; the MCP tool maps `OpError` to a tool error. Change the op, not the action, when a rule changes, and run `mcp.db.test.ts`.
- **Paid lookups** (`research-tools.ts`) must quote credits with `creditsFor()` and run only with `max_credits` at or above the price and a key with the `research` scope (`canResearch()`), through `load()` in `src/modules/keywords/dfs.ts`. Every key sees these tools, and saved results are free for any key.

## Ownership: one module, one set of files

Each module session owns **only** these paths for its module key (`domains`, `keywords`, `rank`, `local`, `audit`, `backlinks`, `google`, `posthog`, `plausible`, `umami`, `ai`, `fixes`, `indexing`):

| Path | What goes there |
|---|---|
| `src/modules/<key>/**` | Data access, DataForSEO and Google calls, transforms, client components, `jobs.ts`, `dashboard.tsx` |
| `src/db/schema/<key>.ts` | This module's tables. Prefix table names with the module, e.g. `rank_keywords`. |
| `src/app/(app)/<route>/**` | Pages: domains→`/domains`, keywords→`/keywords`, rank→`/rank`, local→`/local`, audit→`/audit`, backlinks→`/backlinks`, google→`/gsc` + `/ga4` + `/api/google/**`, posthog→`/api/posthog/**` (its panel renders on `/ga4`), plausible→no routes (its panel renders on `/ga4`), ai→`/ai` |
| `src/modules/<key>/*.test.ts` | Vitest tests |

`src/modules/setup/` (the guided setup) belongs to no module session: it proposes from the domains, rank and AI data and applies through their ops, never their tables.

**Do not edit shared files:** `src/components/**`, `src/lib/**`, `src/db/index.ts`, `src/db/schema/core.ts`, `src/db/schema/index.ts`, `src/lib/jobs/registry.ts`, the layouts, `package.json`, `next.config.ts`, and anything outside your paths. If you need a shared change (a new UI primitive, a new dependency, a column on `projects`), put your own version inside `src/modules/<key>/`, and list the change you wanted under "Shared changes requested" in your final report. A maintainer merges those. The one exception: the `google` module may write `projects.gscProperty` and `projects.ga4Property`, the `posthog` module `projects.posthogProject`, and the `plausible` module `projects.plausibleSite`. A project has one of a GA4 property, a PostHog project or a Plausible site: they share `ga4_landing_daily`, so setting one clears the others and their rows.

New npm dependency: don't run `pnpm add`. List it in your report. If you truly can't proceed without it, run `pnpm add` and say so plainly in the report. `package.json` and `pnpm-lock.yaml` conflicts are a maintainer's to resolve.

## Database

- Drizzle with `casing: "snake_case"`: write camelCase in TypeScript, and the database gets snake_case.
- Every tenant-owned table has `workspaceId` (NOT NULL, indexed) and, when it has a `projectId`, a composite foreign key to `projects(workspace_id, id)`, so a row can't point at another workspace's project. Copy the pattern from an existing module schema. A table with no `workspaceId` must be listed in `GLOBAL_TABLES` (`src/db/schema/core.ts`); `src/db/schema/tenancy.test.ts` fails otherwise. See "Workspaces" below.
- Add indexes for the queries your pages run, e.g. `(projectId, date)`.
- **Migrations:** `drizzle/0000`–`0044` exist (0004 Better Auth, 0005 and 0006 workspaces, 0007 billing, 0008 the site waitlist, 0009 the free tools' request log and cache, 0010 API keys, 0011 the PostHog source, 0012 the Local SEO tables and `ai_prompts.topic`, 0013 and 0014 Local SEO radius in miles, 0015 `projects.ai_include_branded`, 0016 `api_ledger.source` and `api_key_usage`, 0017 rank rechecks: `rank_tasks.attempt` and `look`, `rank_runs.rechecks` and `not_checked`, `rank_results.not_checked`, 0018 `dfs_places`, `projects.city_code` and `city_name`, `location_code` on `rank_runs` and `rank_results`, 0019 `projects.business_type` and `served_towns`, 0020 `projects.setup_searches`, 0021 the Free plan: `workspaces.plan` defaults to `free`, and `none` rows move to it, 0022 fix records, 0023 who started a rank run, 0024 `users.welcome_email_at` and `workspace_usage.limit_email_at`, 0025 the Plausible source: `plausible_accounts` and `projects.plausible_site`, 0026 plan grants: `workspaces.granted_at`, `grant_ends_at` and `granted_by`, 0027 `signup_claims`, one Free account per inbox, 0028 `api_cache_claims`, one DataForSEO fetch per cache key at a time, 0029 `free_site_claims`, one Free workspace per site, 0030 `spend_reservations`, one row per spend reservation in flight, so a busy workspace's leaked ones clear, 0031 indexes on the foreign keys a delete follows (`rank_results.run_id`, `rank_tasks.keyword_id`, `ai_overviews.prompt_id`, `api_ledger.project_id`) and two indexes dropped that a unique index already covered, 0032 OAuth for the MCP server: Better Auth's `oauth_*` and `jwks` tables, and `oauth_connections` and `oauth_connection_usage`, 0033 the Umami source: `umami_accounts` and `projects.umami_site`, 0034 drops three unused `workspace_settings` columns: `default_location_code`, `default_language_code` and `email_notifications`, 0035 first-visit columns on `users`, 0036 `users.weekly_recap` and `recap_sends`, 0037 `domains_teardowns`, saved competitor teardowns, 0038 `ai_actions`, the status of each AI visibility action and the outreach list, 0039 `content_briefs`, saved content briefs, 0040 `alert_rules`, `alerts` and `alert_sends` for urgent alerts, and `users.alert_emails`, 0041 `indexing_settings` and `indexing_pages` for the Not indexed list and IndexNow, 0042 `indexing_pages.requested_at`, 0043 `free_site_claims.verified`, a claim whose holder proved it owns the site in Search Console, 0044 renames the owner workspace from the hosted service's address to `My workspace`, unless it was renamed). The web app can serve new code before the worker has migrated, so a migration that new code depends on ships first, in a commit of its own. After a schema change, run `pnpm db:generate --name <what_changed>`, review the SQL, then run `pnpm db:migrate` and commit the migration together with the schema change. (During the parallel build, module branches used `drizzle-kit push` and committed no migrations, so they wouldn't collide.)
- One active run per project is enforced by partial unique indexes on `rank_runs` and `audit_crawls`, and one active check per business on `local_checks`. Catch the unique violation (Postgres code 23505) and show "already running" instead of an error.
- Store raw API payloads sparingly: keep the fields you render or need for history, not whole responses.

## Billing

Plans, quotas, gates, caps and spend are in `src/lib/billing/`.

- **Plan checks go through `src/lib/billing/gates.ts`** (pure) and `workspace.ts` (counts), which forward to the plan policy (`@/plan-policy/*`, `src/lib/billing/policy.ts`). Never import a plan file such as `plans.ts` from core: a copy without plans has none. A Server Action that adds keywords, prompts or projects asks the matching gate first and shows its message; one that changes or runs a project checks `projectActionRefusal(scope)` (read-only projects after a downgrade) and, for paid work, `{ paid: true }`.
- **Admin's plan figures come from the plan policy** (`@/plan-policy/admin`): what a plan adds to Overview, Health, Workspaces and a workspace's page. Core Admin shows accounts, workspaces, projects, spend and jobs, and reads no subscription or payment columns itself.
- **Paid jobs** use `jobScope(payload, { paid: true })`. A refused job is recorded in `workspace_job_pauses` and resumed after an upgrade, or once the platform cap or a new month gives it room (`resumeLapsedPauses`); never throw from a refused job. One that was going to post a run or check closes that row first, so nothing waits on a job that isn't coming.
- **The DataForSEO client reserves every paid call** against the workspace ceiling (and research credits for the domains, keywords, backlinks and local modules, `RESEARCH_MODULES` in `src/lib/billing/usage.ts`) before it runs. Wrap plan-covered work in a research module in `onPlanMeter()` so it doesn't use credits.
- **Run buttons show credits** for research (`costLabel()` in `src/modules/keywords/format.ts`). Local SEO counts as research, scheduled checks included, so its Find listing and Check now buttons show credits too, plus dollars where `showsDollarCosts(ws)` is on.
- **Plan-covered work shows no dollars in the app.** Rank checks, audits, Lighthouse and AI prompts show the plan's limit instead, such as pages per crawl or keyword units, on every workspace. `showsDollarCosts(ws)` is off, with one flag in `gates.ts` to bring dollars back for the internal plan. Admin, MCP tool estimates and raw vendor error text still go by `isInternal(ws)`.
- **Offer Upgrade now at a limit only if it helps:** `upgradeRaises(ws, limit)`, the plan policy's answer. A copy without plans never offers it.
- **Never print or commit payment keys or signing secrets.** Nothing in the suite talks to a payment provider.

## DataForSEO

Always go through `src/lib/dataforseo/client.ts`. Never `fetch` DataForSEO directly.

```ts
import { dfsPost, dfsGet, firstResult, taskResults, TTL } from "@/lib/dataforseo/client";

const res = await dfsPost<RankedKeywordsResult>(
  "dataforseo_labs/google/ranked_keywords/live",
  [{ target: "example.com", location_code: 2840, language_code: "en", limit: 1000 }],
  { module: "domains", projectId, ttlSeconds: TTL.week },
);
const result = firstResult(res); // throws DataForSEOError on a failed task; 40102 "no results" → empty
```

- **Options on every call:**
  - `ttlSeconds`: cache lifetime.
  - `force`: skip the cache read.
  - `free`: for free endpoints. It skips the budget check and the ledger.
  - `estimateUsd`: refuse the call if month-to-date spend plus this estimate would pass the cap.
  - `retries`: how many times to retry an HTTP 5xx. Defaults to 0 for `task_post`, because a 5xx there may still have created a paid task, and 2 elsewhere. 429s are always retried.
- **`recordLedgerAdjustment({ endpoint, module, projectId, deltaUsd })`** writes a correction outside a call:
  - a negative delta for an On-Page crawl refund;
  - a positive delta for the real cost of a Standard llm_responses answer above the prepay.
  - Record each adjustment once, when the row changes to done.
- **Free calls:** pass `free: true` for `task_get`, `tasks_ready`, `summary` and `appendix`. Their responses repeat the task's price, and counting it again would double the month's spend.
- **Pick a cache TTL for every research call**, using `docs/dataforseo.md` §4. The cache key is the endpoint plus the request body, so equal requests are free.
- **Standard queue** (rank tracking, Local SEO, On-Page, AI Overview checks): post with `ttlSeconds: 0`. Poll `tasks_ready` and `task_get` with `{ free: true }`, from a worker job, never from a page render.
- **The budget is enforced for you.** `BudgetExceededError` is thrown before a paid call once the month's spend reaches the cap, or once the call's `estimateUsd` would push it past the cap.
- **Research pages spend only on request.** A page renders cached data for free, and otherwise offers a Run that states its cost ("Run (≈ N credits)") and adds `run=1` to the URL. Links between pages never include `run=1`. Pages read it through `wantsRun` (`src/lib/run-request.ts`), never straight off `searchParams`: only a request from SEOpen's own page (`Sec-Fetch-Site: same-origin`) may spend. Any other link (another site, a public tool on the marketing site, an email or chat app, a typed address, a browser without Fetch Metadata) still carries the SameSite=Lax session cookie, so there `run=1` is ignored and the page shows its Run button instead. While the workspace can't spend for a reason the banner gives, every Run, Analyze, Compare and Load the rest button is off with that reason as its title. Pages render errors with `<ApiError error={e} />` from `@/components/api-error`.
- **Failures read in plain words.** `ApiError` shows a refusal as written and anything else through `plainFailure` (`src/lib/dataforseo/failure-copy.ts`, which also covers Google, PostHog, Plausible and Umami errors): a title, a message and `retry`, false when trying again can't work, so no Retry shows. Raw vendor text goes to the server log and appears on screen only for the internal plan (`showsDollarCosts`). Stored crawl and Lighthouse errors go through `plainCrawlFailure` and `plainLighthouseFailure`.
- Any button that spends money says roughly what it costs: research Run buttons in credits ("Run (≈ 2 credits)"); plan-covered checks in dollars, only where `showsDollarCosts(ws)` is on.
- Write TypeScript types for the response fields you use, in `src/modules/<key>/types.ts`. Don't type whole responses.

**Live testing:** keep test spend small, set a low monthly cap for the workspace you test with, and check spend on `/admin/spend`, where every call is listed by module. `on_page/instant_pages` has returned 50402 "Target page took too long", so handle that status and prefer `task_post` crawls.

## Background jobs

In `src/modules/<key>/jobs.ts`:

```ts
import { defineJob, type AnyJobDef } from "@/lib/jobs/types";
import { jobScope, type ProjectJobPayload } from "@/lib/workspace";

export const jobs: AnyJobDef[] = [
  defineJob<ProjectJobPayload>({
    name: "rank.check",           // must start with "<key>."
    cron: "15 6 * * *",           // optional, local time
    cronData: {},                 // payload for scheduled runs
    policy: "singleton",
    handler: async (payload) => {
      const scoped = await jobScope(payload);   // checks the project belongs to the workspace
      if (!scoped.ok) return { skipped: scoped.reason };
      /* ... use scoped.scope ... */
    },
  }),
];
```

- Queue a job from a Server Action with `enqueue("rank.check", scope)` from `@/lib/jobs/boss`, where `scope` is the `ProjectScope` (`{ workspaceId, projectId }`) you got from `requireProject()`. A scheduled run has no project: fan out one job per project with `activeProjects()`.
- Handlers must be idempotent, because they can retry.
- Store each job's progress or state in your module's tables, so pages can show it, e.g. "Crawl running, 120/500 pages".
- `pnpm worker` must start cleanly with your jobs registered.

## Workspaces (tenancy)

Workspaces own all customer data. Helpers are in `src/lib/workspace/`.

- `currentWorkspace()` is the only way to resolve the workspace in a request. It reads the Better Auth session through `requireSession()` and returns the workspace of the user's first membership (an account with none gets an error).
- In pages, actions and routes, load a project with `requireProject(id)` (`src/lib/projects.ts`). It returns `{ project, scope }` and a 404 for another workspace's project. Never query by an id from a URL or form alone: filter with `inScope(table, scope)`.
- Jobs carry `{ workspaceId, projectId }` and check it with `jobScope()`; a mismatch returns `{ skipped }`.
- DataForSEO calls take the workspace: the ceiling, credits and ledger are per workspace, plus a platform-wide cap (`platform.monthly_cap_usd` in `settings`). See Billing above. Only public market data is cached across workspaces, and a workspace that didn't pay for a shared hit is charged for it and gets it as `cached: false`, like a fresh lookup, so nothing shows that another workspace looked it up. Its next hit is its own and comes back `cached: true`.
- Google connections are per workspace (`google_accounts.workspace_id`).
- Prove isolation with a test in the style of `src/lib/workspace/isolation.db.test.ts`: act as workspace B against workspace A's data. DB tests run only against `seopen_test`.
- **Worker code:** the worker runs in plain Node (`tsx src/worker.ts`), where importing `server-only` throws at load and takes every job down. Anything a job reaches can't import `server-only`. Tests mock it, so they won't catch this: after adding a job or changing what one imports, load `@/lib/jobs/registry` with tsx and call `loadJobs()`, which also loads `src/lib/jobs/extra.ts` where that file exists.
- **Shipping a migration:** the web app can go live before the worker runs migrations, so web code that needs a new column errors for a few minutes. Ship schema changes first in a migration-only commit that old code tolerates (defaults, nullable columns), then the code. A column on an existing table goes further: leave `src/db/schema/` out of that commit (the SQL, snapshot and journal only) and change the schema with the code, because `db.select()` asks for every column in the schema, so a schema change in the first commit fails on that table until the worker has migrated.

## UI kit (`src/components/ui`)

| Component | Use |
|---|---|
| `PageHeader` | Every page: title, where the numbers come from and how fresh they are, actions. `helpHref` adds "How this works" for a module with no tab row. `as="div"` is for a site mockup, where the page already has its `h1`. |
| `BackLink` | One level up, above a detail page's title. Never prefetches a project URL. |
| `Briefing` | The top of every module page: one plain sentence saying what changed and against what, then figures. The sentence is a pure function over stored data (`briefSentence` in `src/lib/brief.ts`, then each module's `brief.ts`), and "nothing moved" is a real answer. |
| `Figure`, `EmptyFigure`, `FigureStrip` | The one way to show a number: label, figure, change, what it covers. The figure stays in the text colour; only the change carries better or worse. `position` adds the 1–20 gauge, `small` is for a strip inside a card. `EmptyFigure` says why there's no number, with one next step. `FigureStrip` is the row: filled tiles 8px apart, wrapping to the column. |
| `FigureView` | Draws a `FigureData`, for a page whose figures come from a pure function |
| `Section` | A titled stretch of page with no box. Tables and charts sit here. |
| `Card`, `CardHeader`, `CardBody` | Forms and settings |
| `DataTable` | Serializable column specs from Server Components. Has sorting, filtering, paging and CSV export. Formats: number, usd, pct (takes a 0–1 ratio), date, datetime, position, url, link (with an `href` template), badge, delta. |
| `DataTableCore` | The same table with TanStack `ColumnDef`s, for client components that need custom cells |
| `FilterBar` | Controls above a table, for free views only. A pick applies at once, replacing the URL with the same params the page already reads, and never carries `run`. Without JavaScript it's a GET form with a button. A form that spends has a button and a cost instead. |
| `SpendConfirm` | A submit button that spends, with its cost on the button. It's primary and runs on one click only when `first` (the page has nothing to show yet); otherwise it's secondary and asks in place. |
| `TimeChart` | The one time chart, plain SVG with no animation: a real time scale, a break at every null, a ruler from the dates, a crosshair the arrow keys also drive (one tab stop), a table view. Forms: `line`, `columns`, `position`. |
| `Trend` | A series drawn as what it has earned: nothing, a number, from → to, "no change", weekly columns or a line. `chooseChart` in `src/lib/chart-rule.ts` decides, with tests, and `chooseLines` does the same for several series on one axis. Takes a format's name, so a server component can use it. Reach for this before `TimeChart`. |
| `Tabs`, `ModuleTabs` | Link-based sub-navigation within a module, e.g. `/rank`, `/rank/pages`, `/rank/competitors`. The row scrolls sideways on a narrow screen. `tabHref` (`tab-href.ts`) carries the page's query but never `run`. `helpHref` adds "How this works"; `ModuleTabs` adds the Suspense tabs need and gets that link from `guideHref`. Rankings hides Pages and Cannibalization until a check has results (`RankTabs hasResults`). |
| `PageFailure` | What `error.tsx` shows when a page fails, inside the sidebar. It never prints the error, and Try again reloads without `run`. |
| `RetryButton` | Tries a failed page or section again. With `run` in the address, `withoutRun` drops it, so a retry never spends without showing the price. |
| `Gauge`, `PositionGauge` | A reading on a tick scale, with a ghost needle for the earlier one. `PositionGauge` is the 1–20 rank scale |
| `Delta` | A signed change with its arrow. Say which way is good through `tone` |
| `Segmented`, `SegmentedLinks` | A small set of mutually exclusive options. `SegmentedLinks` is the same as links, for a choice kept in the URL: the view stays linkable, and a server component can draw it. |
| `Button`, `ButtonLink`, `Input`, `Select`, `Textarea`, `Label`, `Badge`, `Callout`, `EmptyState` | The basics |
| `EmptyState` `level` | Heading level of its title: 2 by default (under the page's h1), 1 when it replaces the whole page, 3 inside a card |

Also available:
- `@/lib/format`: `formatNumber`, `formatUsd`, `formatPct`, `formatDay` (a calendar date, `YYYY-MM-DD`, the same day in every zone), and for instants `formatDate`, `formatShortDate`, `formatDateTime` and `formatTimestamp`, which all take the workspace's zone
- `@/lib/projects`: `getCurrentProject()`, `listCompetitors(projectId)`, `normalizeDomain()`. `getCurrentProject()` and `listProjects()` are cached per request with React `cache()`, so call them wherever you need them.
- `@/lib/dataforseo/locations`: market codes
- `<NoProject />` from `@/components/require-project`: the empty state for project-scoped pages

Style: use the design tokens (`bg-surface`, `text-muted`, `border-line`, `text-accent`, `text-good`, `text-warn`, `text-bad`, `bg-surface-2`), never raw hex colors. In `globals.css`: `figure` is the big readout and is never coloured, `data` is numbers and timestamps in rows, and `caps-label` is a figure's label. Outfit sets words, big figures, prices and sentences. Geist Mono, through `data` or `font-mono`, sets deltas, chart ticks, tooltips, table numbers, dates in rows, URLs in cells, range codes and shortcuts. `digits` gives the numbers in a caption the data size, in Outfit. `app-type` sets the signed-in small type on the `(app)`, `(admin)` and `(auth)` roots: labels, data and `text-xs` all 13px. Ticks appear in the app only where they measure, on `Gauge`'s scale and `TimeChart`'s ruler, which draw their own. `module-rail` is a page and its side rail: one column until the main column reaches 64rem, then a 20rem rail on the right. `panel` is there too. The main button is `bg-accent-fill` with `text-accent-fg` in both themes; `text-accent` is the readable value for links and focus. Blue (the accent) means act here and green means a number moved the right way, so a status stays neutral. The theme follows the system until someone picks one (`src/lib/theme.ts`), and the server never reads the choice, so pages stay static. The light-mode text colors clear WCAG AA (4.5:1) on `bg`, `surface-2` and their own 12–15% badge tints; keep it that way if you change them. Marks that aren't text (gauge arcs, status dots) only need 3:1, so warn marks use `--warn-mark`, which is lighter than `--warn`. Don't nest bordered tiles inside a `Card`; use spacing and dividers. Layouts should be dense and calm, and both light and dark mode must work. Outfit's figures stay proportional, so digits that must line up in a column use `data`. Research tools (domains, keywords, backlinks) take their input from the URL (`?q=example.com`), so results can be linked and reloaded.

## Dashboard card

The full contract is the doc comment at the top of `src/components/ui/module-card.tsx`; read it before touching a card. In short:

- `src/modules/<key>/dashboard.tsx` exports `dashboard: DashboardModule<Data>`: an `id`, a `label` and `href`, a `setup` line (`text` and `href`) for when there's no data, `load(project)`, a `describe(data)` header line, and a pure `View({ data })`. A card that shows changes also has `baseline(data)` (what they compare against: "previous 28 days", a date, "previous crawl"; null when there's nothing earlier) and `changes(data)` (one `compare(label, current, previous, { unit, goodWhen, format })` per changing KPI).
- A module that checks something on its own also gives `failures(projects, timeZone)`: the projects whose newest check failed or whose connection needs redoing, read with one batched query, never one per project. `loadFailures` then asks `checkGate` (`src/lib/billing/check-gate.ts`, read once per workspace, no email) what the button would do: a check the plan rules out or a locked project raises no alarm (`summaryFailure`), and a workspace that can't spend right now keeps the failure with the refusal in place of "runs it again" (`pageFailure`, which the module's own page uses too). A check stuck posting past the hour says "didn't start" and isn't red (`stuck`), because a refused job and a worker backlog look the same. Overview and All projects then say the source needs a look instead of "small changes", "steady" or "waiting", and its numbers stay on screen labelled as older. MCP's `get_overview` and `what_changed` read the same `loadFailures` and give it as `last_run_failed`. Only the newest row counts: a later success clears it, and a check in flight isn't one. The customer's words go in `reason`, through `src/lib/dataforseo/failure-copy.ts`. An Analytics source (GA4, PostHog or Plausible) that syncs fine while its newest day of data is `DATA_STOPPED_DAYS` (14) or more behind the last day it asked for is the third kind, `stopped` (`src/modules/google/failure.ts`): it reads "No data since Oct 1" with what usually causes it, its changes lose their good or bad tone (`withoutTone`), `/ga4` leads with it, and Admin Health lists it.
- `load` reads only your module's stored data. No paid calls, no writes. Return `null` when there's nothing to show; Overview then names the module in its one "Not set up yet" line, linked to `setup.href`, and MCP reads `setup.text`. A module that can be set up but have no results yet (rank keywords before their first check, AI prompts before their first run) also has `waiting(project)`, a line such as "8 keywords tracked, waiting for the first check"; it's asked only when `load` returns null, and the row goes under "Waiting for first results" instead of "Not set up". A loader that throws shows as a "Couldn't load" row and logs the error.
- The frame (`ModuleCard`) draws the header: title link, the `describe` line, and "View →". Views show numbers with `KpiRow` and `Kpi`, a small `Figure` that takes a `delta` (a `ChangeDelta` from `countDelta` or `changeDelta` in `src/lib/brief.ts`, or `deltaBetween` in `what-changed.tsx`; null when there's no baseline; a change that prints as one point reads "+1 pt", through `inPoints`), and lay out sections with `ModuleSection`, `ModuleList` and `ModuleNote`.
- Paid and destructive buttons ask in place with `ConfirmSubmit` (`src/components/ui/confirm-submit.tsx`), never `window.confirm`, which froze the tab in testing. Links that start paid work set `prefetch={false}`.
- Dates go through `@/lib/format`, never the machine's zone. Calendar dates use `formatDay`. Instants take the workspace's zone: `await currentTimeZone()` on the server, `useTimeZone()` in a client component, `workspaceTimeZone(scope)` where there is no request. Building a calendar string with a time needs `T12:00:00` appended, and chart labels use `chartDay()`. A workspace picks its zone on `/settings`; a new one starts on the zone of its first member's browser (`applyBrowserTimeZoneOp`), which never touches a workspace that has a `workspace_settings` row or predates `BROWSER_ZONE_FROM`. A time of day people act on (last run, next run, a scheduled check) names its zone: `formatDateTimeZoned()`, or `zonedJobTime()` and `mondayJobTime().zoned` for a job. Plain dates and table cells don't: the section above a table says it once with `timeZoneLabel()` (a zone with no offset reads "GMT" on every Node version, never "GMT+0"), and `/settings` and the Guide's schedule name the full zone. Jobs run on one clock for everyone (`SCHEDULE_TIME_ZONE` in `src/lib/schedule.ts`), so copy that states a job's time converts it with `jobTime()` or `mondayJobTime()`, and a changed cron line means changing the time in that copy too.
- `src/modules/<key>/dashboard.fixtures.ts` exports `fixtures` with `full`, `sparse` and `long` states (plus any extra under `more`). The dev-only preview at **`/dev/cards`** renders every state of every card, plus the rows and the empty state. It returns 404 in production.
- A new module adds its `dashboard` to `DASHBOARD_MODULES` in `src/app/(app)/dashboard-modules.ts` (that order is the dashboard order; the first module is the empty state's first setup step) and its `fixtures` to `FIXTURES` in `src/app/(app)/dev/cards/page.tsx`.

`/` depends on how many projects the workspace has: none shows the "add a project" empty state, one shows that project's Overview, and two or more show All projects. Archived projects are listed under any of them. A project's Overview lives at `/projects/[id]` and its settings at `/projects/[id]/settings`; `/projects` redirects to `/`. Opening a project URL also makes it the current project: `src/proxy.ts` sets the `seopen_project` cookie on the request as well as the response, so the switcher is right on the first render. That's why links to a project use `prefetch={false}`. Only a live project of the account's workspace counts (`isLiveProject` in `src/lib/workspace/current.ts`): a dead link, an archived project's settings or another workspace's id leaves the cookie alone, so the current project stays.

A project's Overview (`src/app/(app)/project-dashboard.tsx`) runs every loader in parallel through `loadModules` in `dashboard-load.ts`, behind one skeleton, then renders in order: a `Briefing` (the sentence, then five figures: Clicks, Tracked position or, with nothing tracked, Search Console position, On page one, AI citing you and Site health), a `module-rail` with the clicks chart beside "What changed", the keyword table, a `ModuleCard` for every module with data, "Waiting for first results" and "Couldn't load" rows, the "Not set up yet" line, and a last line saying when each module last ran (`finishLine`). `buildHeadlines` in `dashboard-headlines.ts` turns the loaders' results into the figures and rows, and the site's `OverviewScreen` (`src/components/site/app-mock/screens.tsx`) draws the same page from the same parts with made-up data. The modules the figures read say their own states there (not connected, waiting, couldn't load), so the lists leave them out. A loader that takes over 5 seconds counts as failed ("took too long to load"), and failed rows have a Retry button. One card spans the full width instead of leaving half the row empty. If no module has data or failed, it shows an empty state: "set up and waiting for its first results" (with when checks run) when something is waiting, otherwise Start guided setup and the first module's setup.

All projects (`all-projects.tsx`, `project-board.tsx`) opens with one sentence (`boardSentence` in `project-summary.ts`) on how many projects need a look and the worst of them, then one card per project, sorted by Needs a look (the default), Name or Biggest change. A card has the project's sentence, any failures with Retry, a clicks sparkline and six figures from `summarize`, always in this order: Clicks, On page one, AI citing you, Site health, Organic sessions, Backlinks. A figure with no data says why. The figures carry no links, because module pages read the current project, which isn't this card's until it's opened. Projects with nothing set up end the page in a "Nothing set up yet" list. Two projects load at a time (`AT_ONCE`), so their loaders don't time each other out. /dev/cards renders the board from fixtures. `Sparkline` (`src/components/ui/sparkline.tsx`) is plain SVG, and this is its only use: neutral (`--muted`) on every card, so it never argues with the change beside it. It follows `chooseChart`, summing sparse clicks by week and drawing nothing when the rule asks for a note instead.

"What changed" (`src/components/ui/what-changed.tsx`) lists what moved, each row saying what it covers, because modules compare against different windows. Four rows come first, in a fixed order: clicks (the latest 7 days of stored data against the 7 before, summed from the Search Console card's daily series), tracked position (against the check nearest 7 days earlier), AI answers citing you (against the previous run) and pages with errors (against the previous crawl: distinct page URLs with an error in `PAGE_ERROR_CODES`, read from `audit_issues`, while the audit card's Errors counts every error issue). Overview shows only the ones with a value, since the figures already say why the others have none. The rest of every card's `changes` follow through `pickHighlights`, which ranks them by how far each moved from where it started (`changeWeight`), skips moves on too little data (`enoughData`: a relative change in counts needs 20 on one side; a rate or average passed a `volume` needs 100 impressions or sessions), leaves out Clicks and Tracked position, and lists up to three worse and three better.

## App shell

`src/app/(app)/layout.tsx` puts a skip link, then the sidebar (`src/components/shell/sidebar.tsx`), then `main#main` inside the `@container/main` wrapper. Breakpoints inside the page are measured from that column (`@2xl/main`, `@3xl/main`, `@5xl/main`), never from the window, because the sidebar takes a different width in each state. The sidebar is 232px from `lg`, a 56px icon rail from `md` to `lg` unless the person has opened it, and a slim bar with a `<dialog>` drawer below `md`. The choice is stored in `seopen_sidebar` and applied by an inline script before paint, so it doesn't flash; the `rail:` variant styles both ways of being a rail. Only the nav list scrolls, so the switcher and Account stay in reach. Every sidebar and palette link is `prefetch={false}`: opening `/projects/<id>` switches the project cookie, so a prefetch must never reach it. What's in the nav, what's lit and which project is current are pure functions in `nav-model.ts`, with tests; add nav items there. The rows and their icons are in `nav-links.tsx`, which the site's mockups draw too. With no projects only what works without one shows; with one, Overview is lit on `/` and All projects hides; with two or more, All projects owns `/`, `/projects`, `/projects/new` and archived project URLs, and Overview keeps pointing at the current project. Cmd+K opens `command-palette.tsx`, which navigates only and never carries `?run=1`. The project switcher (`src/components/shell/project-select.tsx`) is a button and listbox, not a native select: arrow keys move, Enter picks, Escape closes, a filter box comes first from 7 projects, and its footer links to all projects, archived projects (`/#archived`) and New project. The layout doesn't re-render on a client navigation and the project cookie is httpOnly, so the sidebar keeps the last project a URL named and asks `GET /api/projects/current` after each navigation, to always name the project the page shows. `--page-pad` sets the page's side padding.

## Customer pages and Admin

`/agents`, `/settings`, a hosted service's billing page and the public docs at `/docs` look the same to every workspace, the owner workspace's included, so an admin sees what a customer sees. The one exception is the export card on `/settings`, which lists a workspace's own tables, so the Plausible table only shows where `docs/plausible.md` says it can. They never show dollars, DataForSEO, hosting, job names or internal docs. Operator content lives under `/admin`, in its own `(admin)` route group and shell (`src/app/(admin)/layout.tsx`, the app's sidebar with Admin's pages: no project switcher, credits meter or billing banner). Access belongs to accounts, not a workspace: `requireAdmin()` and `assertAdmin()` in `src/lib/admin/access.ts` check the admin list (`platform.admin_user_ids` in `settings`), and only while that list is empty do the members of the owner workspace (`OWNER_WORKSPACE_ID`) count as admins. Anyone else gets a 404. Admins are added on Admin → Users (Add admin makes the account and its own workspace if needed and emails a set-password link; no beta seat) and the last admin can't be removed. Seven sidebar pages (`adminNav` in `nav-model.ts`): `/admin` (Overview: accounts, paying workspaces, monthly revenue at list prices, the waitlist, DataForSEO spend as a meter against the platform cap, the beta funnel (the waitlist's own people only, each step a subset of the one before: invited, signed in, started a trial or plan, paying; plan and revenue tiles count every customer workspace), 30-day small multiples of waitlist joins, new accounts and spend through `DailyColumns` (`src/components/admin/daily-columns.tsx`: counts go by the chart rule, spend stays daily columns in cents), and Health counts; from `src/lib/admin/overview.ts`), `/admin/workspaces` (workspaces, plans, trials, Suspend; each name opens `/admin/workspaces/[id]` with that workspace's plan and Stripe state, members, projects, connections, spend by module and its problems), `/admin/users` (the admin list with Add admin and Remove, then every account, its workspace, verification, sign-in method and last session), `/admin/health` (a low DataForSEO balance or a recent HTTP 402 from it, failed jobs in 7 days, Search Console, GA4, PostHog and Plausible syncs that errored or haven't succeeded for 3 days, broken connections, paused jobs, spend alerts and billing problems, from `src/lib/admin/health.ts`), `/admin/spend` (platform cap, the owner workspace's cap, spend by module, API ledger, background jobs). When a module's price or behaviour changes, update the in-app docs' credit or plan-limit wording together with it.

## Finishing (module builds)

1. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` all pass.
2. Check every page in the browser with real data on a test project, or say why you couldn't.
3. Commit on your branch with clear messages. Don't merge to `main` and don't push.
4. Final report covering:
   - what works, and what you verified and how
   - API spend
   - "Shared changes requested"
   - schema tables added
   - jobs added
   - known gaps
