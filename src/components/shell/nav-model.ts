/**
 * What the sidebar lists and which item is lit, as pure functions so the rules are tested without a
 * browser. The number of projects changes the shape:
 *   none      only what needs no project; the switcher offers the first project.
 *   one       no All projects; Overview is that project and is also lit on /.
 *   two up    All projects owns / and everything that isn't one live project's page.
 * `count: null` is the Suspense fallback: every label, nothing lit, nothing that names a project.
 */

import { adminExtra } from "@/admin-extra";
import { DOCS_ORDER, docsPath } from "@/lib/docs";
import type { AdminLink } from "./admin-link";
import { rules } from "@/plan-policy/rules";

export type NavIconKey =
  | "all"
  | "overview"
  | "rank"
  | "audit"
  | "fixes"
  | "gsc"
  | "ga4"
  | "ai"
  | "mcp"
  | "local"
  | "backlinks"
  | "settings"
  | "alerts"
  | "keywords"
  | "domains"
  | "workspaces"
  | "users"
  | "waitlist"
  | "health"
  | "spend"
  | "runbook";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIconKey;
  active: boolean;
}

export interface NavGroup {
  /** Omitted for a group that needs no heading. */
  label?: string;
  items: NavItem[];
}

const under = (href: string, pathname: string) => pathname === href || pathname.startsWith(`${href}/`);

/** The project a /projects/<id> URL names, read on its own so this module stays free of imports. */
const pathProject = (pathname: string) => /^\/projects\/(\d+)(?:\/|$)/.exec(pathname)?.[1] ?? null;

/**
 * The project the shell shows. The URL wins while it names a live project; then the last one a URL
 * or the server named; then what the layout rendered with; then the first. An archived project's
 * settings page names a project the list doesn't have, so it can't win, and the switcher never
 * shows a name it can't offer.
 */
export function resolveCurrentId(ids: readonly number[], candidates: { path: string | null; known: string | null; server: number | null }): number | null {
  const live = (v: string | number | null) => {
    const n = Number(v);
    return v != null && v !== "" && ids.includes(n) ? n : null;
  };
  return live(candidates.path) ?? live(candidates.known) ?? live(candidates.server) ?? ids[0] ?? null;
}

/**
 * The modules by what they're about. Within a group your own data comes first and research last.
 * `noProject` works without one, so it's all that shows before the first project exists.
 * A module's own pages stay as tabs on the page, because some of them need the domain or keyword it's looking at.
 */
const GROUPS: { label: string; modules: { href: string; label: string; icon: NavIconKey; noProject?: boolean }[] }[] = [
  {
    label: "Domain",
    modules: [
      { href: "/audit", label: "Site audit", icon: "audit" },
      { href: "/fixes", label: "Fixes", icon: "fixes" },
      { href: "/backlinks", label: "Backlinks", icon: "backlinks" },
      { href: "/domains", label: "Domain analysis", icon: "domains", noProject: true },
    ],
  },
  {
    label: "SEO",
    modules: [
      { href: "/rank", label: "Rankings", icon: "rank" },
      { href: "/gsc", label: "Search Console", icon: "gsc" },
      { href: "/ga4", label: "Analytics", icon: "ga4" },
      { href: "/keywords", label: "Keyword research", icon: "keywords", noProject: true },
    ],
  },
  { label: "Local", modules: [{ href: "/local", label: "Local SEO", icon: "local" }] },
  {
    label: "AI",
    modules: [
      { href: "/ai", label: "AI visibility", icon: "ai" },
      { href: "/agents", label: "MCP", icon: "mcp", noProject: true },
    ],
  },
];

/**
 * The project a page is about, or null for a page about the account or the whole workspace. A
 * /projects/<id> URL is about the project it names, and only if that one is live. Home is a project's
 * Overview only when there's one project. Research that works without a project isn't about one.
 */
export function pageProjectId(pathname: string, ids: readonly number[], currentId: number | null): number | null {
  const named = pathProject(pathname);
  if (named != null) return ids.includes(Number(named)) ? Number(named) : null;
  if (pathname === "/") return ids.length === 1 ? currentId : null;
  return GROUPS.some((g) => g.modules.some((m) => !m.noProject && under(m.href, pathname))) ? currentId : null;
}

export function appNav({ count, currentId, pathname }:{ count: number | null; currentId: number | null; pathname: string }): NavGroup[] {
  const id = currentId == null ? null : String(currentId);
  const named = pathProject(pathname);
  const onProjectPage = named != null && named === id;
  const hasProject = count !== 0;
  const overview = id ? `/projects/${id}` : "/";
  const settings = id ? `/projects/${id}/settings` : "/";
  const alerts = id ? `/projects/${id}/alerts` : "/";

  const top: NavItem[] = [];
  if (count != null && count >= 2) {
    const onThatList = pathname === "/" || pathname === "/projects" || pathname === "/projects/new";
    // An archived project's settings names no live project, so it stays with the list it's reached from.
    top.push({ href: "/", label: "All projects", icon: "all", active: onThatList || (named != null && !onProjectPage) });
  }
  if (hasProject) top.push({ href: overview, label: "Overview", icon: "overview", active: id != null && (pathname === overview || pathname === `${overview}/setup` || (count === 1 && pathname === "/")) });

  const modules: NavGroup[] = GROUPS.map((g) => ({
    label: g.label,
    items: g.modules.filter((m) => hasProject || m.noProject).map(({ href, label, icon }) => ({ href, label, icon, active: under(href, pathname) })),
  })).filter((g) => g.items.length);

  return [
    ...(top.length ? [{ items: top }] : []),
    ...modules,
    ...(hasProject
      ? [
          {
            items: [
              { href: alerts, label: "Alerts", icon: "alerts" as const, active: id != null && under(alerts, pathname) },
              { href: settings, label: "Project settings", icon: "settings" as const, active: id != null && pathname === settings },
            ],
          },
        ]
      : []),
  ];
}

const CORE_ADMIN: readonly AdminLink[] = [
  { href: "/admin", label: "Overview", icon: "overview" },
  { href: "/admin/workspaces", label: "Workspaces", icon: "workspaces" },
  { href: "/admin/users", label: "Users", icon: "users" },
  { href: "/admin/health", label: "Health", icon: "health" },
  { href: "/admin/spend", label: "Spend", icon: "spend" },
];

/** Core's Admin pages with any extra ones (`@/admin-extra`) placed after the page each names. */
export function withAdminExtra(core: readonly AdminLink[], extra: readonly AdminLink[]): AdminLink[] {
  const out = [...core];
  for (const e of extra) {
    const at = e.after ? out.findIndex((l) => l.href === e.after) : -1;
    out.splice(at === -1 ? out.length : at + 1, 0, e);
  }
  return out.map(({ href, label, icon }) => ({ href, label, icon }));
}

const ADMIN = withAdminExtra(CORE_ADMIN, adminExtra);

export function adminNav(pathname: string): NavGroup[] {
  return [{ items: ADMIN.map((m) => ({ ...m, active: m.href === "/admin" ? pathname === "/admin" : under(m.href, pathname) })) }];
}

export interface PaletteEntry {
  href: string;
  label: string;
  /** Extra words it answers to, and the muted second part of the row. */
  hint?: string;
}

export interface PaletteGroup {
  label: string;
  entries: PaletteEntry[];
}

/** Every page Cmd+K can open. Plain paths only: `run` spends on arrival, so it can never appear here. */
const PAGES: PaletteEntry[] = [
  { href: "/rank", label: "Rankings" },
  { href: "/rank/competitors", label: "Competitors", hint: "Rankings" },
  { href: "/rank/pages", label: "Pages", hint: "Rankings" },
  { href: "/rank/cannibalization", label: "Cannibalization", hint: "Rankings" },
  { href: "/rank/settings", label: "Settings", hint: "Rankings" },
  { href: "/audit", label: "Site audit" },
  { href: "/audit/issues", label: "Issues", hint: "Site audit" },
  { href: "/audit/pages", label: "Pages", hint: "Site audit" },
  { href: "/audit/compare", label: "Compare crawls", hint: "Site audit" },
  { href: "/gsc", label: "Search Console" },
  { href: "/gsc/queries", label: "Queries", hint: "Search Console" },
  { href: "/gsc/pages", label: "Pages", hint: "Search Console" },
  { href: "/gsc/opportunities", label: "Opportunities", hint: "Search Console" },
  { href: "/gsc/countries-devices", label: "Countries & devices", hint: "Search Console" },
  { href: "/gsc/indexing", label: "Indexing", hint: "Search Console" },
  { href: "/gsc/inspect", label: "URL inspection", hint: "Search Console" },
  { href: "/gsc/sitemaps", label: "Sitemaps", hint: "Search Console" },
  { href: "/ga4", label: "Analytics" },
  { href: "/ai", label: "AI visibility" },
  { href: "/ai/prompts", label: "Prompts", hint: "AI visibility" },
  { href: "/ai/sources", label: "Sources", hint: "AI visibility" },
  { href: "/ai/brands", label: "Brands", hint: "AI visibility" },
  { href: "/local", label: "Local SEO" },
  { href: "/backlinks", label: "Backlinks" },
  { href: "/backlinks/referring-domains", label: "Referring domains", hint: "Backlinks" },
  { href: "/backlinks/links", label: "Links", hint: "Backlinks" },
  { href: "/backlinks/anchors", label: "Anchors", hint: "Backlinks" },
  { href: "/backlinks/gap", label: "Gap", hint: "Backlinks" },
  { href: "/backlinks/toxic", label: "Link review", hint: "Backlinks" },
  { href: "/keywords", label: "Keyword research" },
  { href: "/keywords/ideas", label: "Ideas", hint: "Keyword research" },
  { href: "/keywords/lists", label: "Saved lists", hint: "Keyword research" },
  { href: "/keywords/briefs", label: "Content briefs", hint: "Keyword research" },
  { href: "/domains", label: "Domain analysis" },
  { href: "/domains/keywords", label: "Keywords", hint: "Domain analysis" },
  { href: "/domains/pages", label: "Top pages", hint: "Domain analysis" },
  { href: "/domains/competitors", label: "Competitors", hint: "Domain analysis" },
  { href: "/domains/gap", label: "Keyword gap", hint: "Domain analysis" },
  { href: "/settings", label: "Workspace settings" },
  ...(rules.plansHref ? [{ href: rules.plansHref, label: "Billing" }] : []),
  { href: "/agents", label: "MCP", hint: "AI agent keys" },
  { href: "/docs", label: "Docs" },
  { href: "/projects/new", label: "New project" },
];

/** The docs pages about a hosted service's plans and credits, which a copy without plans doesn't offer. */
const PLAN_DOCS: ReadonlySet<string> = new Set(["getting-started/credits-and-limits", "account/billing"]);

/** Every docs page, under its sidebar label in the docs (src/lib/docs.ts), so searching a module's name finds its docs too. */
const DOCS_PAGES: PaletteEntry[] = DOCS_ORDER.filter((p) => rules.hasPlans || !PLAN_DOCS.has(p.slug)).map((p) => ({ href: docsPath(p.slug), label: p.label, hint: "Docs" }));

/** The modules about one project, in the sidebar's order. */
const PROJECT_MODULES: PaletteEntry[] = GROUPS.flatMap((g) => g.modules)
  .filter((m) => !m.noProject)
  .map(({ href, label }) => ({ href, label }));

/**
 * `currentId` puts the project in hand first: the pages the sidebar and Project settings reach for it, so
 * a long list of projects can't push them below the fold. Before the data arrives there is none.
 */
export function appPalette({ projects, owner, currentId = null }: { projects: readonly { id: number; name: string; domain: string }[]; owner: boolean; currentId?: number | null }): PaletteGroup[] {
  const groups: PaletteGroup[] = [];
  const current = projects.find((p) => p.id === currentId);
  if (current) {
    groups.push({
      label: "This project",
      entries: [
        { href: `/projects/${current.id}`, label: "Overview", hint: current.name },
        ...PROJECT_MODULES,
        // The hint is what the sidebar and the page call it, so searching those words finds it.
        { href: `/projects/${current.id}/settings`, label: `${current.name} settings`, hint: "Project settings" },
        { href: `/projects/${current.id}/setup`, label: "Guided setup", hint: current.name },
        { href: `/projects/${current.id}/alerts`, label: "Alerts", hint: current.name },
      ],
    });
  }
  if (projects.length) groups.push({ label: "Projects", entries: projects.map((p) => ({ href: `/projects/${p.id}`, label: p.name, hint: p.domain === p.name ? undefined : p.domain })) });
  const pages = current ? PAGES.filter((p) => !PROJECT_MODULES.some((m) => m.href === p.href)) : PAGES;
  groups.push({ label: "Pages", entries: owner ? [...pages, { href: "/admin", label: "Admin" }] : pages });
  groups.push({ label: "Docs", entries: DOCS_PAGES });
  return groups;
}

export function adminPalette(): PaletteGroup[] {
  return [{ label: "Admin", entries: [...ADMIN.map(({ href, label }) => ({ href, label })), { href: "/", label: "Open the app" }] }];
}

/** Case-insensitive, every word must match somewhere in the label or hint, so "search pages" finds Pages under Search Console. */
export function filterPalette(groups: readonly PaletteGroup[], query: string): PaletteGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...groups];
  return groups
    .map((g) => ({ ...g, entries: g.entries.filter((e) => words.every((w) => `${e.label} ${e.hint ?? ""}`.toLowerCase().includes(w))) }))
    .filter((g) => g.entries.length);
}
