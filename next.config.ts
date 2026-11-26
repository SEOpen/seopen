import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { adminExtraFile } from "./src/components/shell/admin-extra-file";
import { planPolicyAliases } from "./src/lib/billing/policy-file";
import { billingProviderFile } from "./src/lib/billing/provider-file";
import { docsRedirects, hasMarketingSite } from "./src/lib/docs-redirects";
import { APP_PREFIXES, splitHosts } from "./src/lib/hosts";
import { publicSignupAliases } from "./src/lib/public-signup/file";
import { PROXY_BODY_LIMIT_BYTES } from "./src/lib/web/body-limit";

// Read at build time. Production sets both hosts; local dev and previews serve everything from one.
const hosts = splitHosts();
const escape = (host: string) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const nextConfig: NextConfig = {
  cacheComponents: true,
  // Pages and route answers made at run time (a path outside the built set, its 404 included) stay in
  // the memory cache, which has a size limit, and aren't also written under .next/server, which has
  // none: any visitor can ask for any number of made-up paths. What the build wrote is still read
  // from disk. After a restart a run-time page is made again on its first request.
  //
  // The proxy buffers every request body it sees in memory before any check, up to
  // proxyClientMaxBodySize, and hands on a cut-off body past it; src/lib/web/body-limit.ts says why 1 MiB.
  experimental: { isrFlushToDisk: false, proxyClientMaxBodySize: PROXY_BODY_LIMIT_BYTES },
  // Whether this copy has the marketing site (cloud only), so the auth pages link to its home, privacy
  // and terms pages and the waitlist only where they exist (src/lib/hosts.ts, siteLinks).
  env: { SEOPEN_HAS_SITE: hasMarketingSite(process.cwd()) ? "1" : "" },
  // Local single-user app: prefetched route shells add dev noise and no real speedup.
  partialPrefetching: false,
  // PostHog's API paths end in a slash (/ingest/e/), which the built-in redirect would strip.
  // The first redirect below puts that redirect back for every other path.
  skipTrailingSlashRedirect: true,
  async redirects() {
    const trailingSlash = { source: "/:path((?!ingest(?:/|$)).+)/", destination: "/:path", permanent: true };
    // The old beta password page; bookmarks land on account sign-in. The in-app Guide became the
    // site's docs, on the site host once hosts are split.
    // A copy without the docs pages (self-hosted) sends /docs to the hosted docs.
    const rules = [
      { source: "/login", destination: "/sign-in", permanent: true },
      { source: "/guide", destination: hosts ? `https://${hosts.site}/docs` : "/docs", permanent: true },
      ...docsRedirects(process.cwd()),
    ];
    if (!hosts) return [trailingSlash, ...rules];
    const onSite = [{ type: "host" as const, value: escape(hosts.site) }];
    return [
      trailingSlash,
      // The site host only serves the marketing site: app paths move to the app host with their query.
      // /ingest stays: the site's own PostHog relays through it (src/proxy.ts).
      ...APP_PREFIXES.filter((prefix) => prefix !== "/ingest").flatMap((prefix) => [
        { source: prefix, has: onSite, destination: `https://${hosts.app}${prefix}`, permanent: true },
        { source: `${prefix}/:path*`, has: onSite, destination: `https://${hosts.app}${prefix}/:path*`, permanent: true },
      ]),
      { source: "/landing", has: onSite, destination: "/", permanent: true },
      ...rules,
    ];
  },
  async rewrites() {
    return {
      // The marketing home lives at /landing because the app's dashboard owns /.
      beforeFiles: hosts ? [{ source: "/", has: [{ type: "host" as const, value: escape(hosts.site) }], destination: "/landing" }] : [],
      // No rewrite for /ingest here: src/proxy.ts relays it to PostHog itself, with the headers it
      // chose, so a path the proxy doesn't answer has no second way out.
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    // Nothing frames the app on purpose, so no other site can put a signed-in page in a frame.
    // nosniff makes browsers trust each response's Content-Type. The referrer policy pins the browser
    // default: other sites see only the origin, never a path with a project id in it.
    const security = [
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    // One host (self-hosted, local dev, previews): the app and site share it, so every path gets them.
    if (!hosts) return [{ source: "/:path*", headers: security }];
    // Everything on the app host stays out of search results; its robots.txt lets crawlers see this.
    return [{ source: "/:path*", has: [{ type: "host", value: escape(hosts.app) }], headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }, ...security] }];
  },
  turbopack: {
    // A billing provider where the copy has one, none otherwise (src/lib/billing/provider.ts), extra
    // Admin pages where they exist (src/components/shell/admin-extra-file.ts), and public sign-up
    // where the copy has it (src/lib/public-signup/file.ts).
    resolveAlias: { "@/billing-provider": billingProviderFile(process.cwd()), "@/admin-extra": adminExtraFile(process.cwd()), ...planPolicyAliases(process.cwd()), ...publicSignupAliases(process.cwd()) },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// MDX in content/ is imported by the content routes, never routed itself. Plugins are named as
// strings because Turbopack can't take functions; remark-frontmatter keeps the YAML out of the page.
const withMDX = createMDX({
  options: { remarkPlugins: ["remark-frontmatter", "remark-gfm"], rehypePlugins: ["rehype-slug"] },
});

export default withMDX(nextConfig);
