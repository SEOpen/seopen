# One image for both processes: the web app (the default command) and the job worker
# (`src/worker.ts`). compose.yaml runs both beside Postgres.
#
#   docker build -t seopen .
#   docker run --env-file .env -p 127.0.0.1:4100:4100 seopen     # web, this machine only
#   docker run --env-file .env seopen node --import tsx scripts/migrate.ts   # migrations, then exits
#   docker run --env-file .env seopen node --import tsx src/worker.ts

FROM node:24-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
# The version in package.json's packageManager field.
RUN npm install -g pnpm@10.34.9
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# The workspace's extra packages (pnpm-workspace.yaml), each with its own lockfile. A copy without
# any has no src/packages, and the wildcard lets this line match nothing. That needs the whole
# context sent, which the `COPY . .` below does.
COPY src/package[s]/ ./src/packages/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Values Next.js builds into the browser bundle. Pass them as build args (compose.yaml reads them
# from .env); changing one means a rebuild.
ARG NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL=""
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ARG NEXT_PUBLIC_POSTHOG_HOST=""
# A one-host copy leaves these empty. With both hosts set, next.config.ts builds the redirects that
# split the marketing site from the app, so they're read at build time as well as at run time.
ARG SEOPEN_SITE_HOST=""
ARG SEOPEN_APP_HOST=""
# The hosted marketing site's own cookieless PostHog project; empty everywhere else.
ARG NEXT_PUBLIC_POSTHOG_SITE_KEY=""
# The hosted service's own public sign-up, read by its static pages. This repo has no public sign-up
# (src/lib/public-signup/types.ts), so here it does nothing.
ARG SEOPEN_SIGNUP_OPEN=""
# "production" only for the hosted service's own build (src/lib/deploy-env.ts). It's in this build
# stage alone, never the image's runtime, so the worker never inherits it.
ARG SEOPEN_DEPLOY_ENV=""
ENV NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL=$NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    SEOPEN_SIGNUP_OPEN=$SEOPEN_SIGNUP_OPEN \
    SEOPEN_SITE_HOST=$SEOPEN_SITE_HOST \
    SEOPEN_APP_HOST=$SEOPEN_APP_HOST \
    NEXT_PUBLIC_POSTHOG_SITE_KEY=$NEXT_PUBLIC_POSTHOG_SITE_KEY \
    SEOPEN_DEPLOY_ENV=$SEOPEN_DEPLOY_ENV
RUN pnpm build

FROM base AS run
ENV NODE_ENV=production
# The worker runs TypeScript through tsx and applies drizzle/ migrations, so the image keeps the
# source and node_modules beside the build. They stay owned by root, so the runtime user can't
# rewrite the code it runs; it owns only .next/cache, where next start keeps its image and fetch cache,
# and .next/server/route-cache, where Next 16.4 keeps regenerated pages (sitemaps, OG images, guides)
# when it writes them to disk. next.config.ts turns that off (isrFlushToDisk), so the folder stays
# empty; it stays writable so that turning it back on doesn't fail each regeneration with EACCES.
COPY --from=build /app /app
RUN mkdir -p /app/.next/cache /app/.next/server/route-cache && chown -R node:node /app/.next/cache /app/.next/server/route-cache
USER node
EXPOSE 4100
CMD ["pnpm", "exec", "next", "start", "-H", "0.0.0.0", "-p", "4100"]
