# Serving SEOpen to other people

`.env.example` covers running SEOpen on your own machine. This page lists the settings a copy needs
once it's on a server, behind a domain, with other people signing in. Add the ones you need to the
same `.env` or `.env.local`.

## Signing in

**Securing a copy you put online is your responsibility.** SEOpen is free software and comes with no
warranty ([LICENSE](../LICENSE)). Decide who should reach your copy, and check it before you add
your data.

On your own machine, `SEOPEN_NO_LOGIN=1` (set in `.env.example`) opens the app with no password,
signed in as the owner. On a server, turn it off and use passwords:

1. Remove `SEOPEN_NO_LOGIN` from the env file, or set it to anything but `1`.
2. Give the owner a password. If no-login mode made the account, its email is
   `owner@seopen.localhost`, and `pnpm user:password owner@seopen.localhost` sets one (`docker compose exec web pnpm user:password
   owner@seopen.localhost` in Docker). Or make an account with your own email first:
   `pnpm owner:create you@example.com`.
3. Restart the app so it reads the new setting (in Docker, `docker compose up -d`; `docker compose restart` keeps
   the old one), then open it from another device and check it asks for a password.

No-login mode also turns itself off, request by request, whenever a request doesn't look like it
came from the machine the app runs on (`src/lib/auth/no-login.ts`):

- `SEOPEN_NO_LOGIN` isn't exactly `1`
- `BETTER_AUTH_URL` is set to an address other than `127.0.0.1` or `localhost`, or
  `SEOPEN_SITE_HOST` or `SEOPEN_TRUST_PROXY` is set
- the page was opened at any address other than `127.0.0.1` or `localhost`, even a domain that
  points at this machine
- the visitor's address isn't this machine. In Docker, a browser on the host arrives from the
  container's gateway, which counts as this machine; nothing else does.
- the request carries a `Forwarded` or `CloudFront-Viewer-Address` header, or an `X-Forwarded-For`
  or `X-Real-IP` address that isn't this machine (or, in Docker, the container's gateway)

In Docker Desktop for Mac (tested on 29.9.3), compose's default `127.0.0.1:4100` mapping keeps no-login
working. If you publish the web port beyond `127.0.0.1`, such as `0.0.0.0:4100`, Docker Desktop shows every
connection, the host's own included, from another address, so no-login turns itself off and the copy needs a
password: `docker compose exec web pnpm user:password owner@seopen.localhost`. Publishing the port beyond
`127.0.0.1` on Linux Docker Engine is untested, so don't rely on no-login there; set a password.

These checks are a safety net, not a security boundary. A reverse proxy set up to pass requests
on with `Host: 127.0.0.1` and no forwarding headers looks just like a local browser. Don't rely on
them: on a server, remove the flag. To see why the mode is off for you, open
`/api/auth/local-sign-in` in the browser: it names the check that failed.

## On a domain

- `BETTER_AUTH_URL`: the https address people open, for example `https://seo.example.com`. Sign-in
  refuses any other origin. Unset, it defaults to `http://127.0.0.1:4100`. Set it on the worker as
  well: links in the emails it sends start with it.
- `SEOPEN_TRUST_PROXY=1` when a reverse proxy in front of the app sets `X-Real-IP` or appends
  `X-Forwarded-For`. Sign-in's rate limit keys visitors by that address. Unset, the headers are
  ignored, since anyone reaching the port directly could write their own, and every visitor shares
  one limit.
- `SEOPEN_SITE_HOST`: the copy's public address (`example.com`), for email links and the MCP
  server's website.
- `DATABASE_CA_CERT`: managed Postgres only, the provider's CA certificate as PEM text or a file
  path. Leave it empty for a local or Docker database.
- `MIGRATE_ON_START=1` on the worker applies new `drizzle/` migrations when it starts. The Docker
  compose file doesn't use it: its `migrate` service runs `pnpm db:migrate:start` and exits before
  the web app and the worker start.

## Accounts

- `BETTER_AUTH_SECRET`: optional. Unset, it's derived from `SEOPEN_SECRET_KEY`. Changing either
  signs everyone out.
- There is no public sign-up: you make every account, with `pnpm owner:create` or, for another admin,
  from Admin → Users. `SEOPEN_SIGNUP_OPEN`, `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` did
  something in older versions and do nothing now. An account someone made by signing up before then
  still signs in, and its workspace still runs no paid checks.

## Email and alerts

Email is optional. Without it SEOpen still works: alerts and sign-in links go to the server log
instead. Set it up when you want to hear about problems without watching the app. That matters most
once the worker runs, since it spends DataForSEO money on a schedule.

What it sends:

- **To you, the owner:** the platform spend cap at 80% and 100%, a low DataForSEO balance, the
  DataForSEO account out of funds or at its daily limit, any workspace spending fast, and (with
  `CRON_SECRET`) a worker that stopped. Each goes at most once a day.
- **To the people on a project:** its alert emails (a page with clicks breaks, a keyword leaves the top 10) and the
  weekly recap, once they turn them on.
- **To anyone signing in with a password:** password reset emails, and an invite when you add an admin.

To turn it on:

1. Make a [Resend](https://resend.com) account and an API key.
2. In Resend, add and verify a domain you own, such as `example.com`. Resend sends only from a
   verified domain. Its test sender `onboarding@resend.dev` works without one, but only to your
   Resend account's own address, which is enough to try the alerts on your own machine.
3. Add to the env file and restart (in Docker, `docker compose up -d`):
   - `RESEND_API_KEY`: the key.
   - `EMAIL_FROM`: the sender, on the verified domain, for example `SEOpen <seo@example.com>`.
   - `OWNER_ALERT_EMAIL`: where your alerts go, for example your own inbox.
4. Optional: `NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL`, the address error pages, emails and
   suspended-workspace messages point people to. Set it when other people use your copy. It's built
   into the browser bundle, so set it before building (in Docker, rebuild with
   `docker compose up -d --build`). Unset, SEOpen names no address. It also stands in for
   `EMAIL_FROM` and `OWNER_ALERT_EMAIL` when they're unset.

The server log says why an alert wasn't emailed: `RESEND_API_KEY isn't set here` or
`OWNER_ALERT_EMAIL isn't set here`.

Without `RESEND_API_KEY`, `pnpm dev` prints each email to the server log, so sign-in links still work
on your own machine. A production build (`next start` or the Docker image) refuses to send instead.
Then nobody can use "Forgot your password?": make accounts with
`pnpm owner:create` and set a forgotten password with `pnpm user:password you@example.com` (in
Docker, `docker compose exec web pnpm user:password ...`).

More alert settings:

- `DATAFORSEO_BALANCE_ALERT_USD`: the DataForSEO balance in USD under which you get an email.
  Unset: about a week of calls at your current pace.
- `CRON_SECRET`: the bearer secret for `/api/cron/worker-watch`, which emails you when the worker's
  heartbeat stops. Call the route every 5 minutes with `Authorization: Bearer <secret>` from a
  scheduler outside the worker (cron on the host, say). Unset, the route refuses every call.

## Product analytics

- `NEXT_PUBLIC_POSTHOG_KEY`: a PostHog project key (`phc_...`, public by design) for analytics in
  the signed-in app. Unset: no script, no server events. Only the web app needs it.
- `NEXT_PUBLIC_POSTHOG_HOST`: `https://us.i.posthog.com` (the default) or `https://eu.i.posthog.com`.
  Read at build time, so a change needs a rebuild.
