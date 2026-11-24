/**
 * The order of the docs at /docs: sections, and the pages in each, by their slug under
 * content/docs/. The sidebar, the /docs index and the previous and next links read it, and
 * `pnpm seo:check` fails if a docs page is missing from it or it names a page that doesn't exist.
 * Labels are the sidebar's short names; each page's title and H1 come from its frontmatter.
 */
export type DocsSection = { id: string; title: string; blurb: string; pages: { slug: string; label: string }[] };

export const DOCS: DocsSection[] = [
  {
    id: "getting-started",
    title: "Getting started",
    blurb: "What SEOpen is, your first project, and connecting your data.",
    pages: [
      { slug: "getting-started/introduction", label: "How SEOpen works" },
      { slug: "getting-started/first-project", label: "Your first project" },
      { slug: "getting-started/connect-google", label: "Connect Google" },
      { slug: "getting-started/connect-posthog", label: "Connect PostHog" },
      { slug: "getting-started/schedule", label: "What runs on its own" },
      { slug: "getting-started/credits-and-limits", label: "Credits and limits" },
    ],
  },
  {
    id: "guides",
    title: "Guides",
    blurb: "Step-by-step ways to get something done, start to finish.",
    pages: [
      { slug: "guides/weekly-review", label: "The weekly review" },
      { slug: "guides/fix-loop", label: "Fix issues and check the result" },
      { slug: "guides/quick-wins", label: "Find quick wins" },
      { slug: "guides/get-pages-indexed", label: "Get pages indexed" },
      { slug: "guides/track-ai-answers", label: "Track AI answers" },
      { slug: "guides/google-maps-rankings", label: "Track Google Maps" },
      { slug: "guides/keyword-gap-to-brief", label: "Keyword gap to brief" },
      { slug: "guides/automate-seo", label: "Automate your SEO" },
      { slug: "guides/write-pages-that-rank", label: "Write pages that rank" },
      { slug: "guides/optimize-existing-pages", label: "Optimize existing pages" },
      { slug: "guides/internal-linking", label: "Internal linking" },
      { slug: "guides/comparison-pages", label: "Comparison pages" },
      { slug: "guides/site-migration", label: "Move a site" },
    ],
  },
  {
    id: "features",
    title: "Features",
    blurb: "Every module: what it shows, how to use it, what it costs and when it runs.",
    pages: [
      { slug: "features/projects", label: "Projects" },
      { slug: "features/overview", label: "Overview" },
      { slug: "features/site-audit", label: "Site audit" },
      { slug: "features/fixes", label: "Fixes" },
      { slug: "features/backlinks", label: "Backlinks" },
      { slug: "features/domain-analysis", label: "Domain analysis" },
      { slug: "features/rankings", label: "Rankings" },
      { slug: "features/search-console", label: "Search Console" },
      { slug: "features/analytics", label: "Analytics" },
      { slug: "features/keyword-research", label: "Keyword research" },
      { slug: "features/local-seo", label: "Local SEO" },
      { slug: "features/ai-visibility", label: "AI visibility" },
      { slug: "features/alerts", label: "Alerts and recaps" },
    ],
  },
  {
    id: "agents",
    title: "AI agents",
    blurb: "Work with your SEO data from Claude, Cursor, Codex and other agents.",
    pages: [
      { slug: "agents/connect", label: "Connect an agent" },
      { slug: "agents/plugin", label: "Plugin and skills" },
      { slug: "agents/tools", label: "MCP tools" },
    ],
  },
  {
    id: "account",
    title: "Account",
    blurb: "Plans, billing and workspace settings.",
    pages: [
      { slug: "account/billing", label: "Plans and billing" },
      { slug: "account/workspace-settings", label: "Workspace settings" },
    ],
  },
];

/** A docs page's path on the marketing site. */
export const docsPath = (slug: string) => `/docs/${slug}`;

/**
 * The docs page for each app module, by the module's first path segment: where its "How this
 * works" link goes. Only modules with a tab row or a page-header link are here.
 */
export const MODULE_DOCS: Readonly<Record<string, string>> = {
  audit: "features/site-audit",
  fixes: "features/fixes",
  backlinks: "features/backlinks",
  domains: "features/domain-analysis",
  rank: "features/rankings",
  gsc: "features/search-console",
  ga4: "features/analytics",
  keywords: "features/keyword-research",
  local: "features/local-seo",
  ai: "features/ai-visibility",
};

/** Every docs page in reading order, with its section. */
export const DOCS_ORDER = DOCS.flatMap((s) => s.pages.map((p) => ({ ...p, section: s })));

export const docsSection = (slug: string) => DOCS.find((s) => s.id === slug.split("/")[0]);

/** The pages before and after one, in reading order. */
export function docsNeighbours(slug: string) {
  const i = DOCS_ORDER.findIndex((p) => p.slug === slug);
  return { prev: i > 0 ? DOCS_ORDER[i - 1] : undefined, next: i >= 0 && i < DOCS_ORDER.length - 1 ? DOCS_ORDER[i + 1] : undefined };
}
