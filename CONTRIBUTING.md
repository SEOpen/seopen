# Contributing

Thanks for looking. This repository is the whole app: everything you need to run SEOpen yourself.

## Before you open a pull request

Code from outside the team needs a signed contributor licence agreement, [CLA.md](CLA.md). You keep the copyright in your work; the agreement gives SEOpen Inc. a licence to use it, including under terms other than the AGPL. Read it before you start on a pull request.

The bot that collects signatures isn't switched on yet, so until it is, every pull request from outside the team will be closed unmerged, however good it is. Issues are welcome now: bugs, missing self-hosting steps, and ideas.

When the bot is on, it comments on your first pull request with a link to sign. You sign once with your GitHub account, and it covers every pull request after.

## Reporting a bug

Open an issue with:
- what you did, what you expected and what happened
- whether it's self-hosted (Docker or `pnpm`) and which commit
- the worker's log lines around the failure, with any keys taken out

Security problems go by email, not an issue: see [SECURITY.md](SECURITY.md).

## Working on the code

Requirements: Node 24, pnpm 9 and Postgres 17. The README's "Run it with pnpm" section sets up a local copy.

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

All four must pass. Tests that touch the database use `seopen_test` on your local Postgres; create it with `createdb seopen_test`. A git worktree gets its own test database, made on its first run (`src/db/test-database.ts`), so suites in different worktrees can run at once; set `SEOPEN_TEST_DB` to pick the name.

- Each module lives in `src/modules/<key>/`, with its schema in `src/db/schema/<key>.ts` and its pages in `src/app/(app)/<route>/`.
- Every paid call goes through the shared DataForSEO client (`src/lib/dataforseo/client.ts`), which caches, records each call's cost and enforces spend caps. Don't call a paid API around it.
- A schema change is a Drizzle migration in `drizzle/` (`pnpm db:generate`), checked in with the code that needs it.
- Copy, naming and code conventions are in [docs/conventions.md](docs/conventions.md).
