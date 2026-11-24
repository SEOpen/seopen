import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCS_ORDER } from "@/lib/docs";
import { rules } from "@/plan-policy/rules";
import { adminNav, withAdminExtra, appNav, appPalette, filterPalette, pageProjectId, resolveCurrentId, type NavGroup } from "./nav-model";

const lit = (groups: NavGroup[]) => groups.flatMap((g) => g.items).filter((i) => i.active).map((i) => i.label);
const labels = (groups: NavGroup[]) => groups.flatMap((g) => g.items.map((i) => i.label));
const item = (groups: NavGroup[], label: string) => groups.flatMap((g) => g.items).find((i) => i.label === label);

describe("resolveCurrentId", () => {
  const ids = [3, 5, 8];
  it("lets a URL naming a live project win", () => {
    expect(resolveCurrentId(ids, { path: "5", known: "8", server: 3 })).toBe(5);
  });
  it("ignores an archived project's URL", () => {
    expect(resolveCurrentId(ids, { path: "99", known: "8", server: 3 })).toBe(8);
  });
  it("falls back through what the server said to the first project", () => {
    expect(resolveCurrentId(ids, { path: null, known: null, server: 8 })).toBe(8);
    expect(resolveCurrentId(ids, { path: null, known: "99", server: 99 })).toBe(3);
  });
  it("has nothing to say with no projects", () => {
    expect(resolveCurrentId([], { path: "5", known: null, server: null })).toBeNull();
  });
});

describe("pageProjectId", () => {
  const ids = [3, 5];
  it("is the current project on a module's pages", () => {
    for (const path of ["/rank", "/rank/pages", "/audit/issues/x", "/gsc/queries", "/ga4", "/ai", "/local", "/backlinks/links"]) {
      expect(pageProjectId(path, ids, 5)).toBe(5);
    }
  });
  it("is the project a URL names, even when another one is current", () => {
    expect(pageProjectId("/projects/3", ids, 5)).toBe(3);
    expect(pageProjectId("/projects/3/settings", ids, 5)).toBe(3);
    expect(pageProjectId("/projects/3/setup", ids, 5)).toBe(3);
  });
  it("is nothing for an archived project's URL", () => {
    expect(pageProjectId("/projects/99/settings", ids, 5)).toBeNull();
  });
  it("is nothing on account pages and research that needs no project", () => {
    for (const path of ["/billing", "/settings", "/docs", "/docs/features/rankings", "/agents", "/projects", "/projects/new", "/keywords", "/keywords/lists", "/domains/gap"]) {
      expect(pageProjectId(path, ids, 5)).toBeNull();
    }
  });
  it("doesn't take a path that only starts like a module for it", () => {
    expect(pageProjectId("/rankings", ids, 5)).toBeNull();
  });
  it("is the one project on home, and nothing on home with several", () => {
    expect(pageProjectId("/", [3], 3)).toBe(3);
    expect(pageProjectId("/", ids, 5)).toBeNull();
  });
});

describe("appNav", () => {
  it("groups the modules by category, in order, with your own data before research", () => {
    const nav = appNav({ count: 2, currentId: 3, pathname: "/" });
    expect(nav.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      [undefined, ["All projects", "Overview"]],
      ["Domain", ["Site audit", "Fixes", "Backlinks", "Domain analysis"]],
      ["SEO", ["Rankings", "Search Console", "Analytics", "Keyword research"]],
      ["Local", ["Local SEO"]],
      ["AI", ["AI visibility", "MCP"]],
      [undefined, ["Alerts", "Project settings"]],
    ]);
  });
  it("with no projects, keeps only what needs none, under its own category", () => {
    const nav = appNav({ count: 0, currentId: null, pathname: "/" });
    expect(nav.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["Domain", ["Domain analysis"]],
      ["SEO", ["Keyword research"]],
      ["AI", ["MCP"]],
    ]);
  });
  it("with one project, has no All projects and lights Overview on /", () => {
    const nav = appNav({ count: 1, currentId: 3, pathname: "/" });
    expect(labels(nav)).not.toContain("All projects");
    expect(lit(nav)).toEqual(["Overview"]);
    expect(item(nav, "Overview")?.href).toBe("/projects/3");
  });
  it("with two projects, lights All projects on / and Overview on the project", () => {
    expect(lit(appNav({ count: 2, currentId: 3, pathname: "/" }))).toEqual(["All projects"]);
    expect(lit(appNav({ count: 2, currentId: 3, pathname: "/projects/3" }))).toEqual(["Overview"]);
    expect(lit(appNav({ count: 2, currentId: 3, pathname: "/projects/3/setup" }))).toEqual(["Overview"]);
  });
  it("points Project settings at this project and lights only it there", () => {
    const nav = appNav({ count: 2, currentId: 3, pathname: "/projects/3/settings" });
    expect(item(nav, "Project settings")?.href).toBe("/projects/3/settings");
    expect(lit(nav)).toEqual(["Project settings"]);
  });
  it("calls the row what the page calls itself", () => {
    const page = readFileSync(fileURLToPath(new URL("../../app/(app)/projects/[id]/settings/page.tsx", import.meta.url)), "utf8");
    expect(page).toContain(`<PageHeader title="Project settings"`);
    expect(page).toContain(`metadata = { title: "Project settings" }`);
  });
  it("points Alerts at this project and lights it on an alert's link too", () => {
    const nav = appNav({ count: 2, currentId: 3, pathname: "/projects/3/alerts/12" });
    expect(item(nav, "Alerts")?.href).toBe("/projects/3/alerts");
    expect(lit(nav)).toEqual(["Alerts"]);
  });

  it("keeps an archived project's settings with All projects", () => {
    expect(lit(appNav({ count: 2, currentId: 3, pathname: "/projects/99/settings" }))).toEqual(["All projects"]);
  });
  it("lights a module on its sub-pages, whole segments only", () => {
    expect(lit(appNav({ count: 2, currentId: 3, pathname: "/rank/pages" }))).toEqual(["Rankings"]);
    expect(lit(appNav({ count: 2, currentId: 3, pathname: "/rankings" }))).toEqual([]);
  });
  it("lights nothing and names no project before the data arrives", () => {
    const nav = appNav({ count: null, currentId: null, pathname: "" });
    expect(lit(nav)).toEqual([]);
    expect(item(nav, "Overview")?.href).toBe("/");
    expect(labels(nav)).not.toContain("All projects");
  });
  it("never links anywhere with a query, because run spends", () => {
    for (const g of appNav({ count: 2, currentId: 3, pathname: "/" })) for (const i of g.items) expect(i.href).not.toContain("?");
  });
});

describe("adminNav", () => {
  it("places an extra after the page it names, or last", () => {
    const core = [
      { href: "/a", label: "A", icon: "overview" as const },
      { href: "/b", label: "B", icon: "users" as const },
    ];
    const extra = [
      { href: "/x", label: "X", icon: "health" as const, after: "/a" },
      { href: "/y", label: "Y", icon: "spend" as const },
      { href: "/z", label: "Z", icon: "spend" as const, after: "/gone" },
    ];
    expect(withAdminExtra(core, extra).map((l) => l.label)).toEqual(["A", "X", "B", "Y", "Z"]);
    expect(withAdminExtra(core, []).map((l) => l.label)).toEqual(["A", "B"]);
  });

  it("lights Overview only on /admin itself", () => {
    expect(lit(adminNav("/admin"))).toEqual(["Overview"]);
    expect(lit(adminNav("/admin/users"))).toEqual(["Users"]);
  });
});

describe("the palette", () => {
  const groups = appPalette({ projects: [{ id: 3, name: "Mill Town", domain: "milltown.example" }], owner: false });
  it("never carries a query, because run spends", () => {
    for (const g of groups) for (const e of g.entries) expect(e.href).not.toContain("?");
  });
  it("keeps Admin from anyone who isn't an owner", () => {
    expect(groups.flatMap((g) => g.entries).some((e) => e.href === "/admin")).toBe(false);
    const owner = appPalette({ projects: [], owner: true });
    expect(owner.flatMap((g) => g.entries).some((e) => e.href === "/admin")).toBe(true);
  });
  it("matches every word across the label and hint", () => {
    const found = filterPalette(groups, "search pages").flatMap((g) => g.entries);
    expect(found.map((e) => e.href)).toEqual(["/gsc/pages"]);
  });
  it("calls Domain analysis's pages what its tab does", () => {
    const entry = groups.flatMap((g) => g.entries).find((e) => e.href === "/domains/pages");
    expect(entry).toMatchObject({ label: "Top pages", hint: "Domain analysis" });
  });
  it("finds a project by domain and drops empty groups", () => {
    const out = filterPalette(groups, "milltown");
    expect(out.map((g) => g.label)).toEqual(["Projects"]);
  });

  describe("for the current project", () => {
    const projects = [
      { id: 3, name: "Mill Town", domain: "milltown.example" },
      { id: 5, name: "High Plains", domain: "highplains.example" },
    ];
    const current = appPalette({ projects, owner: false, currentId: 5 });
    const hrefs = (query: string) => filterPalette(current, query).flatMap((g) => g.entries.map((e) => e.href));

    it("names its settings and finds them beside the other settings, first", () => {
      expect(hrefs("settings")).toEqual(["/projects/5/settings", "/rank/settings", "/settings", "/docs/account/workspace-settings"]);
      expect(current.find((g) => g.label === "This project")?.entries.find((e) => e.href === "/projects/5/settings")?.label).toBe("High Plains settings");
    });
    it("offers this project's pages first and the projects after them, with nothing typed", () => {
      expect(current.map((g) => g.label)).toEqual(["This project", "Projects", "Pages", "Docs"]);
      expect(current[0].entries.map((e) => e.label)).toEqual(["Overview", "Site audit", "Fixes", "Backlinks", "Rankings", "Search Console", "Analytics", "Local SEO", "AI visibility", "High Plains settings", "Guided setup", "Alerts"]);
      expect(current[0].entries[0].href).toBe("/projects/5");
    });
    it("still searches everything, with each page listed once", () => {
      expect(hrefs("rankings")).toEqual(["/rank", "/rank/competitors", "/rank/pages", "/rank/cannibalization", "/rank/settings", "/docs/features/rankings"]);
      expect(hrefs("mill")).toEqual(["/projects/3"]);
      expect(hrefs("domain analysis")).toContain("/domains/pages");
      const pages = current.filter((g) => g.label !== "Projects" && g.label !== "Docs").flatMap((g) => g.entries.map((e) => e.href));
      expect(new Set(pages).size).toBe(pages.length);
      const everyPage = groups.find((g) => g.label === "Pages")!.entries.map((e) => e.href);
      expect(pages).toEqual(expect.arrayContaining(everyPage));
    });
    it("finds them under the name the sidebar and the page use", () => {
      expect(hrefs("project settings")).toEqual(["/projects/5/settings"]);
    });
    it("finds guided setup, by name and by the project", () => {
      expect(hrefs("guided setup")).toEqual(["/projects/5/setup"]);
      expect(hrefs("setup high plains")).toEqual(["/projects/5/setup"]);
    });
    it("offers them only for the current project", () => {
      expect(hrefs("settings")).not.toContain("/projects/3/settings");
      expect(hrefs("setup")).not.toContain("/projects/3/setup");
    });
    it("has neither before the data arrives, or for a project it doesn't list", () => {
      expect(appPalette({ projects: [], owner: false }).map((g) => g.label)).toEqual(["Pages", "Docs"]);
      expect(appPalette({ projects, owner: false, currentId: 99 }).map((g) => g.label)).toEqual(["Projects", "Pages", "Docs"]);
    });
    it("never carries a query, because run spends", () => {
      for (const g of current) for (const e of g.entries) expect(e.href).not.toContain("?");
    });
  });

  describe("the docs pages", () => {
    const docs = groups.find((g) => g.label === "Docs")?.entries ?? [];

    it.skipIf(!rules.hasPlans)("has every docs page once, in the docs' order, under its sidebar label", () => {
      expect(docs.map((e) => e.href)).toEqual(DOCS_ORDER.map((p) => `/docs/${p.slug}`));
      expect(docs.map((e) => e.label)).toEqual(DOCS_ORDER.map((p) => p.label));
    });
    it.skipIf(rules.hasPlans)("leaves out the plan and credit pages on a copy without plans, and keeps the rest in order", () => {
      const kept = DOCS_ORDER.filter((p) => p.slug !== "account/billing" && p.slug !== "getting-started/credits-and-limits");
      expect(kept.length).toBe(DOCS_ORDER.length - 2);
      expect(docs.map((e) => e.href)).toEqual(kept.map((p) => `/docs/${p.slug}`));
      expect(docs.map((e) => e.label)).not.toContain("Plans and billing");
    });
    it("is found by name and by the word docs", () => {
      const found = (query: string) => filterPalette(groups, query).flatMap((g) => g.entries.map((e) => e.href));
      expect(found("docs rankings")).toEqual(["/docs/features/rankings"]);
      expect(found("site audit")).toContain("/docs/features/site-audit");
      expect(found("posthog")).toEqual(["/docs/getting-started/connect-posthog"]);
      // Plausible is the owner's for now (src/modules/plausible/gate.ts), so the search doesn't offer it.
      expect(found("plausible")).toEqual([]);
    });
  });
});
