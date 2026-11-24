import { existsSync } from "node:fs";
import path from "node:path";

/** Whether this copy has the marketing site's pages. Read at build time. */
export function hasMarketingSite(root: string): boolean {
  return existsSync(path.join(root, "src/app/(site)"));
}

/** Where the docs live when this copy doesn't serve them: the hosted service's site. */
export const HOSTED_DOCS_ORIGIN = "https://getseopen.com";

/**
 * Redirects for /docs on a copy without the docs pages. The app's nav, command palette and "How
 * this works" links read src/lib/docs.ts, which is core, but the pages under content/docs/ and their
 * routes are cloud only, so a self-hosted copy sends /docs to the hosted
 * docs. Empty where the docs route exists. next.config.ts calls this at build time.
 */
export function docsRedirects(root: string) {
  if (existsSync(path.join(root, "src/app/(site)/docs"))) return [];
  return [
    { source: "/docs", destination: `${HOSTED_DOCS_ORIGIN}/docs`, permanent: false },
    { source: "/docs/:path*", destination: `${HOSTED_DOCS_ORIGIN}/docs/:path*`, permanent: false },
  ];
}
