<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## This repo is public

Treat every commit, branch, issue and pull request as public from the moment it exists: no secrets or keys, no customer or client names, no details of anyone's private hosting or accounts. Use made-up examples in tests, fixtures and docs.

The Claude Code plugin and its skills live in their own repo, `SEOpen/seopen-agent`. A new or renamed MCP tool lands here first; the skill that uses it changes there after.

## Running it locally

- `.env.example` is the local setup: `DATABASE_URL`, `SEOPEN_SECRET_KEY` (`openssl rand -base64 32`) and the DataForSEO login are all it needs. The README's "Set it up with an AI agent" prompt walks through it.
- **No login on this machine.** `SEOPEN_NO_LOGIN=1` signs the browser in as the owner with no password (`src/lib/auth/no-login.ts`, `src/lib/auth/no-login-plugin.ts`). Don't make an account to get in, and don't ask for the user's password. If the app shows a sign-in page anyway, `/api/auth/local-sign-in` says which check turned the mode off.
- **Never remove or loosen those checks**, and never set `SEOPEN_NO_LOGIN=1` on a copy reachable from other machines. A server copy uses passwords: `docs/self-hosting.md`, "Signing in".
- Don't start the worker (`pnpm worker:dev`) unasked: it runs paid DataForSEO jobs on a schedule.
