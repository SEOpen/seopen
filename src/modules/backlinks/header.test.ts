import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";

const project = vi.hoisted(() => ({ current: null as { id: number; domain: string } | null }));
const spend = vi.hoisted(() => ({ refusal: null as { code: string; message: string } | null, plan: "starter" }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/backlinks", useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh() {} }) }));
vi.mock("@/lib/workspace/current", () => ({ workspaceScope: async () => ({ workspaceId: 7 }), currentWorkspace: async () => ({ id: 7 }) }));
vi.mock("@/lib/billing/spend", () => ({ spendState: async (workspaceId: number) => (workspaceId === 7 ? { refusal: spend.refusal, workspace: { plan: spend.plan } } : Promise.reject(new Error("wrong workspace"))) }));
vi.mock("@/lib/projects", async (original) => ({ ...(await original<typeof import("@/lib/projects")>()), getCurrentProject: async () => project.current }));

const { BacklinksHeader, BacklinksInvalid, resolveTarget, RunNeeded } = await import("./header");

beforeEach(() => {
  project.current = { id: 3, domain: "alphanote.example" };
  spend.refusal = null;
  spend.plan = "starter";
});

describe("resolveTarget", () => {
  it("normalizes a typed domain", async () => {
    await expect(resolveTarget("https://www.Example.com/page")).resolves.toMatchObject({ target: "example.com", invalid: null, isProjectDomain: false, workspaceId: 7 });
  });

  it("rejects what isn't a hostname, so a page has nothing to look up", async () => {
    await expect(resolveTarget("not a domain")).resolves.toMatchObject({ target: null, invalid: "not a domain", isProjectDomain: false });
    await expect(resolveTarget("  localhost ")).resolves.toMatchObject({ target: null, invalid: "localhost" });
    await expect(resolveTarget("https://")).resolves.toMatchObject({ target: null, invalid: "https://" });
  });

  it("falls back to the project's domain with nothing typed", async () => {
    for (const q of [undefined, "", "   "]) await expect(resolveTarget(q)).resolves.toMatchObject({ target: "alphanote.example", invalid: null, isProjectDomain: true });
  });

  it("has no target and rejects nothing with no project and nothing typed", async () => {
    project.current = null;
    await expect(resolveTarget(undefined)).resolves.toMatchObject({ target: null, invalid: null, isProjectDomain: false });
  });

  it("reads the first of a repeated param", async () => {
    await expect(resolveTarget(["a.com", "b.com"])).resolves.toMatchObject({ target: "a.com" });
  });
});

describe("BacklinksHeader", () => {
  it("calls its button Look up, on the same field", () => {
    const html = renderToStaticMarkup(createElement(BacklinksHeader, { target: "example.com" }));
    expect(html).toContain("Look up");
    expect(html).not.toContain("Analyze");
    expect(html).toContain('name="q"');
    expect(html).toContain('value="example.com"');
  });
});

describe("BacklinksInvalid", () => {
  const html = () => renderToStaticMarkup(createElement(BacklinksInvalid, { invalid: "not a domain" }));

  it("says the same as Domain analysis and keeps what was typed in the box", () => {
    expect(html()).toContain("That isn&#x27;t a domain");
    expect(html()).toContain("“not a domain” isn&#x27;t a hostname like example.com, so nothing was looked up.");
    expect(html()).toContain('value="not a domain"');
  });

  it("offers nothing to spend", () => {
    expect(html()).not.toMatch(/credit|Run|Refresh/);
    expect(html()).not.toContain("run=1");
  });
});

describe("RunNeeded", () => {
  const props = { what: "The rest of the overview", target: "example.com", costUsd: 0.05, basePath: "/backlinks", params: { q: "example.com" }, ttl: "7 days" };
  const render = async (missing?: string) => renderToStaticMarkup(await RunNeeded({ ...props, missing }));
  const SUSPENDED = { code: "suspended", message: "This workspace is suspended." };

  it.skipIf(!rules.hasPlans)("calls its button Run, as every other tab does, with stored numbers on the page", async () => {
    const html = await render("Domain endings");
    expect(html).toContain("Run (≈ 5 credits)");
    expect(html).not.toContain("Load (");
  });

  it("is on while the workspace can spend, as a link with nothing loaded and a form with stored numbers", async () => {
    const first = await render();
    expect(first).toContain('href="/backlinks?q=example.com&amp;run=1"');
    expect(first).not.toMatch(/\bdisabled=""/);
    const rest = await render("Domain endings");
    expect(rest).toContain('<input type="hidden" name="run" value="1"/>');
    // The hidden submit that keeps Enter from running is always off; the visible one is on.
    expect(rest).not.toMatch(/<button(?![^>]*\bhidden="")[^>]*\bdisabled=""/);
  });

  it.skipIf(!rules.hasPlans)("is off with nothing loaded, says why on the button, and has no address that runs", async () => {
    spend.refusal = SUSPENDED;
    const html = await render();
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."[^>]*>Run \(≈ 5 credits\)/);
    expect(html).not.toContain("run=1");
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("suspended");
  });

  it.skipIf(!rules.hasPlans)("on Free, says what Starter adds instead, as the overview does, with nothing that runs", async () => {
    spend.plan = "free";
    for (const missing of [undefined, "Domain endings"]) {
      const html = await render(missing);
      expect(html).toContain("Backlinks are on Starter");
      expect(html).toMatch(/href="\/billing"/);
      expect(html).not.toContain("run=1");
      expect(html).not.toContain('name="run"');
      expect(html).not.toMatch(/Run \(/);
    }
  });

  it("is off with stored numbers on the page, and says why on the button", async () => {
    spend.refusal = SUSPENDED;
    const html = await render("Domain endings");
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."/);
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("suspended");
  });
});
