import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { rules } from "@/plan-policy/rules";
import { NewApiKeyForm, NewKeyResult } from "./new-api-key";

vi.mock("@/app/actions/api-keys", () => ({ createApiKeyAction: vi.fn() }));

const endpoint = "https://app.getseopen.com/api/mcp";
const key = "seopen_abc123";
const html = renderToStaticMarkup(<NewKeyResult name="Laptop" secret={key} endpoint={endpoint} />);
const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

describe("NewKeyResult", () => {
  it("shows the key once, and the line that puts it in the environment", () => {
    expect(text).toContain(key);
    expect(text).toContain(`export SEOPEN_API_KEY="${key}"`);
  });

  it("connects Claude Code in user scope from the environment, never with the key itself", () => {
    expect(text).toContain(`claude mcp add --scope user --transport http seopen ${endpoint} --header 'Authorization: Bearer \${SEOPEN_API_KEY}'`);
    expect(text).not.toContain(`Bearer ${key}`);
  });

  it("gives Cursor and Codex their config files", () => {
    expect(text).toContain("~/.cursor/mcp.json");
    expect(text).toContain("${env:SEOPEN_API_KEY}");
    expect(text).toContain("~/.codex/config.toml");
    expect(text).toContain('bearer_token_env_var = "SEOPEN_API_KEY"');
  });

  it("has a Copy button for the key, the export line and each agent's snippet", () => {
    expect(html.match(/>Copy</g)).toHaveLength(5);
  });

  it("can take focus, so the page can move to it once the key is made", () => {
    expect(html).toMatch(/^<div[^>]*tabindex="-1"/);
  });
});

describe("NewApiKeyForm", () => {
  const made = renderToStaticMarkup(<NewApiKeyForm state={{ ok: true, key, name: "Laptop" }} action={() => {}} pending={false} endpoint={endpoint} />);

  it("puts the new key above the form, where the person is looking, not under the emptied form", () => {
    expect(made.indexOf(key)).toBeGreaterThan(-1);
    expect(made.indexOf(key)).toBeLessThan(made.indexOf("<form"));
  });

  it("keeps a refusal under the form it's about", () => {
    const refused = renderToStaticMarkup(<NewApiKeyForm state={{ ok: false, message: "Give the key a name." }} action={() => {}} pending={false} endpoint={endpoint} />);
    expect(refused.indexOf("Give the key a name.")).toBeGreaterThan(refused.indexOf("<form"));
  });
});

describe("NewApiKeyForm on Free", () => {
  const free = renderToStaticMarkup(<NewApiKeyForm state={null} action={() => {}} pending={false} endpoint={endpoint} free />);
  const paid = renderToStaticMarkup(<NewApiKeyForm state={null} action={() => {}} pending={false} endpoint={endpoint} />);

  it("offers research credits only where the plan has them", () => {
    expect(paid).toContain('name="research"');
    expect(free).not.toContain('name="research"');
  });

  it.skipIf(!rules.hasPlans)("says where credits come from instead, with a link to Billing", () => {
    expect(free).toContain("Research credits come with Starter");
    expect(free).toMatch(/<a [^>]*href="\/billing"/);
  });

  it.skipIf(rules.hasPlans)("links nowhere for plans on a copy without them", () => {
    expect(free).not.toContain("href=");
    expect(free).not.toContain("See plans");
  });

  it("says paid steps need the credits box too, and doesn't tell Free about credits it doesn't have", () => {
    expect(free).not.toContain(`such as Local SEO, also need ${rules.researchScope}`);
    expect(paid).toContain(`such as Local SEO, also need ${rules.researchScope}`);
  });

  it("says what checks count against: the plan on getseopen.com, the DataForSEO cap without plans", () => {
    const said = paid.replace(/&#x27;/g, "'");
    expect(said).toContain(rules.hasPlans ? "Checks count against your plan. Steps that use research credits, such as Local SEO, also need Can spend research credits." : "Checks count against the workspace's monthly DataForSEO cap. Research steps, such as Local SEO, also need Can run research lookups.");
    if (!rules.hasPlans) expect(said).not.toMatch(/\bplan\b/i);
  });
});
