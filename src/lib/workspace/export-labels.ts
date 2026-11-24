/**
 * What the export card calls each table. Only the card: the download's JSON keys, CSV file names and
 * the requests to /settings/export keep the table's own name. export.db.test.ts fails if an exported
 * table has no name here. The page reads these on the server and hands the card only what it offers,
 * so a workspace that isn't offered Plausible's or Umami's table never gets its name.
 */
const LABELS: Record<string, string> = {
  workspace: "Workspace",
  members: "Members",
  account: "Your account",
  sign_in_methods: "Your sign-in methods",
  sessions: "Your signed-in browsers",
  waitlist: "Your beta waitlist entry",
  api_ledger: "Usage records",
  alert_rules: "Alerts: rules switched off",
  alerts: "Alerts: history",
  ai_actions: "AI visibility: actions and their status",
  ai_brand_aliases: "AI visibility: other names for your brands",
  ai_llm_mentions: "AI visibility: mentions across AI assistants",
  ai_overviews: "AI visibility: Google AI Overviews",
  ai_prompts: "AI visibility: tracked questions",
  ai_results: "AI visibility: answers",
  ai_runs: "AI visibility: checks",
  api_keys: "MCP API keys",
  audit_crawls: "Site audit: crawls",
  audit_duplicates: "Site audit: duplicate content",
  audit_issues: "Site audit: issues",
  audit_lighthouse: "Site audit: Lighthouse scores",
  audit_links: "Site audit: links",
  audit_non_indexable: "Site audit: pages kept out of search",
  audit_pages: "Site audit: pages",
  audit_resources: "Site audit: images, scripts and other files",
  audit_settings: "Site audit: settings",
  backlinks_domain_decisions: "Backlinks: domains you marked keep or disavow",
  backlinks_snapshots: "Backlinks: saved numbers",
  competitors: "Competitors",
  content_briefs: "Keyword research: content briefs",
  domains_snapshots: "Domain analysis: saved numbers",
  domains_teardowns: "Domain analysis: teardowns",
  fixes: "Fixes",
  ga4_landing_daily: "Google Analytics: landing pages by day",
  google_accounts: "Connected Google accounts",
  google_sync_state: "Analytics sources: import progress",
  gsc_breakdown: "Search Console: countries and devices",
  gsc_daily: "Search Console: totals by day",
  gsc_pages: "Search Console: pages",
  gsc_queries: "Search Console: searches",
  gsc_query_pages: "Search Console: searches by page",
  gsc_url_inspections: "Search Console: page index checks",
  indexing_pages: "Indexing: sitemap pages, Google's answers and IndexNow submissions",
  indexing_settings: "Indexing: IndexNow key and settings",
  keywords_list_items: "Keyword lists: keywords",
  keywords_lists: "Keyword lists",
  local_businesses: "Local SEO: businesses",
  local_checks: "Local SEO: checks",
  local_keywords: "Local SEO: keywords",
  local_points: "Local SEO: map results",
  oauth_connections: "MCP connected apps",
  plausible_accounts: "Connected Plausible accounts",
  posthog_accounts: "Connected PostHog accounts",
  projects: "Projects",
  rank_keywords: "Rankings: tracked keywords",
  rank_results: "Rankings: positions",
  rank_runs: "Rankings: checks",
  rank_settings: "Rankings: settings",
  umami_accounts: "Connected Umami accounts",
  workspace_settings: "Workspace settings",
};

/** A table added later and not named yet still reads as words on the card, and the test still fails. */
export function exportLabel(name: string): string {
  const words = name.replaceAll("_", " ");
  return LABELS[name] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether `exportLabel` has a name written for this table, for the test. */
export const hasExportLabel = (name: string) => name in LABELS;
