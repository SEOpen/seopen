import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/client", () => ({ authClient: {} }));

const { rules } = await import("@/plan-policy/rules");

const { ConnectForm, grantedScopes } = await import("./connect-form");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

// The consent page's answer. The provider refuses a consent naming a scope the app didn't ask for.
describe("grantedScopes", () => {
  const none = () => false;
  const all = () => true;

  it("grants reading and a refresh token to an app that asked for every scope, with no box ticked", () => {
    expect(grantedScopes(["read", "write", "research", "offline_access"], none)).toEqual(["read", "offline_access"]);
  });

  it("adds the ticked boxes", () => {
    expect(grantedScopes(["read", "write", "research", "offline_access"], (s) => s === "write")).toEqual(["read", "write", "offline_access"]);
    expect(grantedScopes(["read", "write", "research"], all)).toEqual(["read", "write", "research"]);
  });

  it("never grants a scope the app didn't ask for", () => {
    expect(grantedScopes(["write"], all)).toEqual(["write"]);
    expect(grantedScopes(["read"], all)).toEqual(["read"]);
    expect(grantedScopes([], all)).toEqual([]);
  });
});

describe("ConnectForm", () => {
  it("offers Allow with the read line and the asked-for boxes", () => {
    const html = renderToStaticMarkup(<ConnectForm scopes={["read", "write", "offline_access"]} />);
    expect(text(html)).toContain("Read every project in the workspace");
    expect(html).toContain('name="write"');
    expect(html).not.toContain('name="research"');
    expect(text(html)).toContain("Allow");
  });

  it("explains, and offers only Cancel, when the app didn't ask to read", () => {
    const html = renderToStaticMarkup(<ConnectForm scopes={["write", "offline_access"]} />);
    expect(text(html)).toContain("This app didn't ask to read your workspace.");
    expect(text(html)).toContain("Cancel");
    expect(text(html)).not.toContain("Allow");
    expect(html).not.toContain('name="write"');
  });

  it("names the plan on getseopen.com, and the DataForSEO cap and research lookups without plans", () => {
    const said = text(renderToStaticMarkup(<ConnectForm scopes={["read", "write", "research"]} />));
    if (rules.hasPlans) {
      expect(said).toContain("Checks count against your plan. Steps that use research credits, such as Local SEO, also need Can spend research credits.");
      expect(said).toContain("Can spend research credits Run keyword, domain and backlink lookups.");
    } else {
      expect(said).toContain("Checks count against the workspace's monthly DataForSEO cap. Research steps, such as Local SEO, also need Can run research lookups.");
      expect(said).toContain("Can run research lookups Run keyword, domain and backlink lookups.");
      expect(said).not.toMatch(/\bplan\b|credit/i);
    }
  });
});
