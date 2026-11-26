<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/seopen-lockup-on-dark.svg">
    <img src=".github/assets/seopen-lockup-on-light.svg" alt="SEOpen" width="320">
  </picture>
</p>

<p align="center"><strong>Powerful SEO. Without the premium price.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-2F5FC4" alt="Licence: AGPL-3.0"></a>
</p>

An open-source SEO tool you can run yourself: keyword research, domain analysis, rank tracking, Local SEO across a map grid, site audits, backlinks, Search Console, Analytics and AI visibility, for as many sites as you like. Data comes from your own DataForSEO account and Google's APIs, and an AI agent can read it over MCP and fix what it finds in your site's code. If you'd rather not run it yourself, [getseopen.com](https://getseopen.com) is the hosted version.

## What's in it

| Route | Module | Data source |
|---|---|---|
| `/` | Every project at a glance, or one project's Overview when there's only one | Stored data only |
| `/projects/[id]` | A project's Overview: a one-sentence briefing, five figures, clicks beside "What changed", and a card per module | Stored data only |
| `/domains` | Domain overview, ranked keywords, top pages, competitors, keyword gap | DataForSEO Labs |
| `/keywords` | Keyword overview, ideas (suggestions, related, questions), saved lists | DataForSEO Labs and SERP |
| `/rank` | Daily rank tracking from a country or a city, a weekly depth-100 sweep with AI Overview, competitors, pages, cannibalization | DataForSEO SERP |
| `/local` | Where a Google Maps listing ranks across a 3×3, 5×5 or 7×7 grid around it, per keyword, weekly or on demand | DataForSEO SERP (Google Maps) |
| `/audit` | Site audit crawls, issues by severity, health score, crawl compare | DataForSEO On-Page |
| `/backlinks` | Referring domains, links, anchors, link gap, toxic links | DataForSEO Backlinks |
| `/gsc`, `/ga4` | Search Console and Analytics (GA4, PostHog, Plausible or Umami), synced daily so history outlasts Google's 16 months | Google APIs, PostHog, Plausible, Umami |
| `/ai` | Tracked prompts in ChatGPT, Gemini, Claude and Perplexity: mentions, citations, share of voice, cited sources, AI Overviews | DataForSEO AI Optimization |
| `/fixes` | What to fix on each site, a check that each fix is on the live page, and its clicks before and after | Stored data, Search Console |
| `/agents` | MCP keys, so an AI agent can read your projects and, if you allow it, record fixes | Stored data only |
| `/admin` | Spend caps, spend by module, the API ledger and background jobs | Stored data only |

Most tables export to CSV. Each button that spends money shows its approximate cost first, and research pages make a paid call only when you click **Run**; cached results load free.

## What it costs to run

The software is free. The data isn't: DataForSEO bills you per call, usually fractions of a cent. Backlinks run on a schedule once you add a project; rank tracking, AI visibility and Local SEO once they have keywords, prompts or a listing to check; audits once you turn on the weekly re-crawl. They spend without a click. Two caps stop paid calls before your bill passes them, both in **Admin → Spend**:
- the **platform cap**, on everything this copy spends with DataForSEO in a month (default $100)
- the **owner workspace cap**, on your own workspace (`DATAFORSEO_MONTHLY_CAP_USD`, default $75)

Check `/admin/spend` in your first week to see what your projects use.

## Set it up with an AI agent

Clone or fork this repository, open your coding agent (Claude Code, Codex, Cursor or similar) in the folder, and paste this prompt. It sets up the app on your machine and stops there: it adds no sites and starts nothing that spends money.

```text
Set up SEOpen to run on this machine. Only the app itself: don't add any sites,
projects, keywords or tracking.

1. Read README.md and .env.example first.
2. Check for Node 24, pnpm 9 and Postgres 17, or for Docker with Compose. If
   something is missing, tell me how to install it on my OS and wait. Don't
   install system software yourself.
3. With pnpm and Postgres: run pnpm install, create the databases seopen and
   seopen_test, copy .env.example to .env.local, set SEOPEN_SECRET_KEY to the
   output of `openssl rand -base64 32`, and run pnpm db:migrate.
   With Docker: copy .env.example to .env, set SEOPEN_SECRET_KEY the same way
   and POSTGRES_PASSWORD to a random string of letters and digits, then run
   docker compose up -d --build.
4. Tell me to put my DataForSEO API login and API password (from
   https://app.dataforseo.com/api-access) into DATAFORSEO_LOGIN and
   DATAFORSEO_PASSWORD in the env file myself. If I have no account, say I can
   make one at https://try.dataforseo.com/65m65rikt8ny, or leave them empty
   for now: research pages won't run until they're set.
5. Don't make an account. .env.example sets SEOPEN_NO_LOGIN=1, so on this
   machine the app opens without a password (README.md, "Signing in"). Leave
   it on.
6. Without Docker, start pnpm dev in the background. Check that
   http://127.0.0.1:4100 opens the app without asking for a password. If it
   shows a sign-in page, read the reason at
   http://127.0.0.1:4100/api/auth/local-sign-in and tell me. Don't start the
   worker (pnpm worker:dev):
   it runs paid DataForSEO jobs on a schedule. Tell me how to start it and
   let me decide.
7. Finish with what you set up, which settings in the env file are still
   empty, and what each would turn on.
```

To do it by hand, follow one of the next two sections.

## Run it with Docker

Requirements: Docker with Compose 2.24 or later (`docker compose version` says which), and a DataForSEO account ([sign up here](https://try.dataforseo.com/65m65rikt8ny); an affiliate link, so SEOpen may earn a commission).

```bash
git clone https://github.com/SEOpen/seopen.git
cd seopen
cp .env.example .env
```

In `.env`, set at least:
- `SEOPEN_SECRET_KEY`: the output of `openssl rand -base64 32`
- `POSTGRES_PASSWORD`: any password, letters and digits
- `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`: the **API password** from https://app.dataforseo.com/api-access, not your account password

```bash
docker compose up -d --build
```

Open **http://127.0.0.1:4100** (http://localhost:4100 sends you there). It opens without a password: see [Signing in](#signing-in). A one-off `migrate` service applies the database migrations first, and the web app and the worker start once it's done (`docker compose logs migrate` says "migrations applied").

To update, back up the database ([Backups](docs/self-hosting.md#backups)), then run `git pull` and `docker compose up -d --build` again. Your data is in the `pgdata` volume, which `docker compose down -v` deletes, so leave out `-v`.

The web container listens on 127.0.0.1:4100 only. To serve it on a domain, put a reverse proxy with TLS on the same machine in front of it and follow [docs/self-hosting.md](docs/self-hosting.md).

## Run it with pnpm

Requirements: Node 24, pnpm 9 and Postgres 17.

```bash
git clone https://github.com/SEOpen/seopen.git
cd seopen
pnpm install
createdb seopen && createdb seopen_test
cp .env.example .env.local   # set SEOPEN_SECRET_KEY and the DataForSEO login, as above
pnpm db:migrate
pnpm dev                     # http://127.0.0.1:4100, no password needed
pnpm worker:dev              # in a second terminal: the background jobs
```

The worker makes real paid calls on its schedules, so stop it when you're not using it. In production, run `pnpm build`, then `pnpm start` for the web app and `pnpm worker:start` (with `MIGRATE_ON_START=1`, or run `pnpm db:migrate:start` before both) for the worker.

**Run one worker per database.** Two workers run, and pay for, every scheduled job twice.

## Signing in

**On your own machine there's no login.** `.env.example` sets `SEOPEN_NO_LOGIN=1`, and the app opens signed in as its owner. It makes that account the first time, with no password.

Use it only on a port bound to this machine, as compose and `pnpm dev` set it up. It asks for a password again when a request doesn't look local, but it can't tell whether other machines can reach the port, so don't rely on it to notice. Use passwords on any copy that can be reached from elsewhere, your own network included. These settings always turn it off:
- `SEOPEN_NO_LOGIN` removed, or set to anything but `1`
- a public address or a proxy set (`BETTER_AUTH_URL`, `SEOPEN_SITE_HOST`, `SEOPEN_TRUST_PROXY`)

To see why it's off, open `http://127.0.0.1:4100/api/auth/local-sign-in`.

**On a server, sign-in is yours to set up.** Remove `SEOPEN_NO_LOGIN`, give the owner a password with `pnpm user:password`, and follow [docs/self-hosting.md](docs/self-hosting.md#signing-in). Securing a copy you put online is your responsibility. SEOpen comes with no warranty ([LICENSE](LICENSE)).

## Settings

`.env.example` lists what a copy on your own machine needs, with a note on each. Beyond the three above:

- **Google** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`): Search Console and GA4 need your own Google Cloud project and OAuth client. Until Google verifies your app, sign-in shows a warning screen. Set the app's publishing status to In production: in Testing, Google ends the connection 7 days after you connect. Steps in [docs/google.md](docs/google.md).
- **Local SEO map** (`GOOGLE_MAPS_STATIC_KEY`, `GOOGLE_MAPS_SIGNING_SECRET`): optional. Without them the map uses OpenStreetMap tiles, which are fine for testing but not for commercial use.
- **Analytics sources:** PostHog, Plausible and Umami each connect from a project's Analytics page. PostHog's sign-in needs your copy on an https address, so it can't connect at 127.0.0.1 (`SEOPEN_POSTHOG_FIXTURES`, below, works anywhere). See [docs/posthog.md](docs/posthog.md), [docs/plausible.md](docs/plausible.md) and [docs/umami.md](docs/umami.md).
- **Claude** (`ANTHROPIC_API_KEY`): optional, for guided setup's review. Its calls count against your spend cap.
- **Email alerts** (`RESEND_API_KEY`, `EMAIL_FROM`, `OWNER_ALERT_EMAIL`): optional. An email when the spend cap nears or the DataForSEO balance runs low, instead of a line in the server log. Steps in [docs/self-hosting.md](docs/self-hosting.md#email-and-alerts).
- **Forgotten password:** set a new one from the server with `pnpm user:password you@example.com` (`docker compose exec web pnpm user:password you@example.com` in Docker). It signs the account out everywhere, revokes its API keys and disconnects its connected apps.

Serving a copy to other people (a domain, email, alerts) takes a few more settings, all in [docs/self-hosting.md](docs/self-hosting.md).

### Try it without accounts

These switches serve generated data instead of calling the provider, so the pages fill in before you connect anything. Set any of them to `1`:

- `SEOPEN_GOOGLE_FIXTURES`: Search Console and GA4
- `SEOPEN_POSTHOG_FIXTURES`: PostHog
- `SEOPEN_PLAUSIBLE_FIXTURES`: Plausible
- `SEOPEN_UMAMI_FIXTURES`: Umami

DataForSEO has no switch: research, rank, audits, backlinks, Local and AI visibility need a real account.

## Accounts and workspaces

Each account belongs to a workspace, which owns its projects and data. The owner workspace (number 1) has no plan limits beyond your spend caps. No-login mode signs you in as its owner. On a server, `pnpm owner:create you@example.com` makes the owner's account with a password, and `pnpm user:password you@example.com` gives an existing one a password.

`pnpm owner:create someone@example.com --no-password --customer` gives a second person a workspace of their own. They set a password through "Forgot your password?" once email works ([docs/self-hosting.md](docs/self-hosting.md)), or you set one for them with `pnpm user:password someone@example.com`. There are no plan limits: each workspace you make runs paid checks up to `DATAFORSEO_MONTHLY_CAP_USD` a month, or its own cap from Admin → Spend, under the platform cap. There is no public sign-up: you make every account.

## AI agents (MCP)

The MCP server is at `/api/mcp`. Make a key at `/agents`: read-only by default, or with "Can make changes" to let an agent record and verify fixes. Any MCP client that sends a bearer token works; setup steps for each client are at [getseopen.com/docs/agents/connect](https://getseopen.com/docs/agents/connect). That page is written for the hosted version: where it names `app.getseopen.com`, use your own copy's address.

## How it works

- **Stack:** Next.js 16 (App Router), Tailwind 4, TanStack Table, Drizzle ORM on Postgres, and pg-boss jobs run by a separate worker process (`src/worker.ts`).
- **DataForSEO client** (`src/lib/dataforseo/client.ts`): every paid call goes through it. It caches responses, records each call's cost in `api_ledger`, and refuses a call that would take spend past a cap.
- **Jobs:** registered in `src/lib/jobs/registry.ts` and scheduled on New York time: daily rank checks at 06:00, Local checks at 06:30, Search Console and Analytics syncs from 07:00, fixes at 09:00; on Mondays, audits at 05:30 for projects with the weekly re-crawl on, AI visibility at 07:00, backlinks at 07:30 and the weekly recap at 10:00.
- **Code layout:** each module in `src/modules/<key>/`, its schema in `src/db/schema/<key>.ts`, its pages in `src/app/(app)/<route>/`; shared UI in `src/components/ui/`; migrations in `drizzle/`.
- **More:** [docs/dataforseo.md](docs/dataforseo.md) covers the endpoints and what they cost.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Licence

Copyright (c) 2026 SEOpen Inc.

SEOpen is free software: you can redistribute it and modify it under the terms of the GNU Affero General Public License, version 3 only, as published by the Free Software Foundation. It comes with no warranty. The full text is in [LICENSE](LICENSE).

In short, you can run it, change it and share it. If you share a copy, or let other people use a changed copy over a network, you must offer them its source under the same licence.

The licence doesn't cover the SEOpen name and logos. A copy you offer to other people needs its own name and logo; [TRADEMARKS.md](TRADEMARKS.md) says what's fine without asking.
