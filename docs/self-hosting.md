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
   owner@seopen.localhost` in Docker). It also signs the account out, revokes its API keys and disconnects
   its connected apps, so make or connect those again after. Or make an account with your own email first:
   `pnpm owner:create you@example.com`.
3. Restart the app so it reads the new setting (in Docker, `docker compose up -d`; `docker compose restart` keeps
   the old one), then open `/api/auth/local-sign-in`: it should say `SEOPEN_NO_LOGIN isn't set to 1`.

**Use no-login mode only while the app's port is bound to `127.0.0.1`.** That's how compose,
`pnpm dev` and `pnpm start` run it. The mode can't tell whether other machines can reach the port, so
don't rely on it to notice, whatever Docker or operating system you run. Before you publish the port
wider, on your own network included, or put a reverse proxy or tunnel in front of it, remove the flag
and set a password. Anyone who can reach a copy with the mode on may get in as its owner.

The mode does check each request, and asks for a password when one doesn't look local
(`src/lib/auth/no-login.ts`). It's off when:

- `SEOPEN_NO_LOGIN` isn't exactly `1`
- `BETTER_AUTH_URL` is set to an address other than `127.0.0.1` or `localhost`, or
  `SEOPEN_SITE_HOST` or `SEOPEN_TRUST_PROXY` is set
- the page was opened at any address other than `127.0.0.1` or `localhost`, even a domain that
  points at this machine
- the request doesn't look like it came straight from this machine

Only the settings always turn it off. The last two checks catch honest mistakes and aren't a security boundary.
To see why the mode is off for you, open `/api/auth/local-sign-in` in the browser: it names the check that failed.

## On a domain

- `BETTER_AUTH_URL`: the https address people open, for example `https://seo.example.com`. Sign-in
  refuses any other origin. Unset, it defaults to `http://127.0.0.1:4100`. Set it on the worker as
  well: links in the emails it sends start with it.
- `SEOPEN_TRUST_PROXY` when a reverse proxy in front of the app reports the visitor's address.
  Sign-in's rate limit keys visitors by it. Name the header your proxy writes, since it passes the
  other one on as the visitor sent it:
  - `x-forwarded-for` when the proxy appends `X-Forwarded-For`: Caddy's and Traefik's defaults,
    and nginx with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. Only the last
    entry is read.
  - `x-real-ip` when the proxy sets `X-Real-IP` over what the visitor sent, as nginx does with
    `proxy_set_header X-Real-IP $remote_addr;`.

  The older `SEOPEN_TRUST_PROXY=1` means `x-forwarded-for`. Until 2026-11-26 it read `X-Real-IP`
  first, so a proxy that sets only `X-Real-IP` now needs `x-real-ip`. Unset, the headers are ignored, since anyone reaching the port directly could write their own,
  and every visitor shares one limit.
- `SEOPEN_SITE_HOST`: the copy's public address (`example.com`), for email links and the MCP
  server's website.
- `DATABASE_CA_CERT`: managed Postgres only, the provider's CA certificate as PEM text or a file
  path. Leave it empty for a local or Docker database.
- `MIGRATE_ON_START=1` on the worker applies new `drizzle/` migrations when it starts. The Docker
  compose file doesn't use it: its `migrate` service runs `pnpm db:migrate:start` and exits before
  the web app and the worker start.

## Backups

Everything SEOpen keeps is in its Postgres database: in Docker, the `pgdata` volume.
`docker compose down -v` deletes that volume, so leave out `-v` unless you mean to.

Back it up while it runs, from the folder with `compose.yaml`:

```bash
docker compose exec -T postgres pg_dump -U seopen -d seopen -Fc > seopen-$(date +%F).dump
```

To restore one, stop the web app and the worker, restore, then start everything again. The restore
replaces what the database holds with what the backup holds:

```bash
docker compose stop web worker
docker compose exec -T postgres pg_restore -U seopen -d seopen --clean --if-exists --no-owner < seopen-2026-11-26.dump
docker compose up -d
```

Keep backups on another machine, and keep a copy of `.env` with them. `SEOPEN_SECRET_KEY` encrypts
the stored Google tokens, so a database restored without the same key has to connect Google again.
Back up before every update, since an update can apply migrations that change the database.

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
