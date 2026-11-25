import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OtherSourceChoices } from "@/modules/analytics-source/choices";
import type { GoogleChoices } from "../properties";
import { NewProjectProperties } from "./new-project-properties";

/** A promise React's `use` reads at once, so a static render doesn't suspend. */
const ready = <T,>(value: T) => Object.assign(Promise.resolve(value), { status: "fulfilled", value });

const google: GoogleChoices = {
  state: "connected",
  sites: [{ siteUrl: "sc-domain:alphanote.test", permissionLevel: "siteOwner" }],
  ga4: [{ property: "properties/9", propertyName: "Other site", account: "accounts/1", accountName: "Acct", streamDomains: ["other.com"] }],
};
const others: OtherSourceChoices = {
  posthog: { state: "connected", items: [{ id: "7", name: "Default project" }] },
  plausible: { state: "connected", items: [{ domain: "alphanote.test" }] },
  umami: { state: "hidden" },
};
const render = (g: GoogleChoices, o?: OtherSourceChoices, typed?: Record<string, string>) =>
  renderToStaticMarkup(<NewProjectProperties choices={ready(g)} others={o ? ready(o) : undefined} domain="alphanote.test" typed={typed} />);

describe("NewProjectProperties", () => {
  it("offers each source on one switch and starts on the one that matches", () => {
    const html = render(google, others);
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/aria-checked="true"[^>]*>Plausible</);
    expect(html).toContain('name="analyticsSource" value="Plausible"');
    expect(html).toContain('name="plausibleSite"');
    // Only the chosen source's list is in the form.
    expect(html).not.toContain('name="ga4Property"');
    expect(html).not.toContain('name="posthogProject"');
    expect(html).toContain('name="gscProperty"');
  });

  it("keeps the source chosen before an error, for the same address", () => {
    const html = render(google, others, { domain: "alphanote.test", analyticsSource: "PostHog", posthogProject: "7" });
    expect(html).toContain('name="analyticsSource" value="PostHog"');
    expect(html).toMatch(/<option value="7" selected="">Default project<\/option>/);
  });

  it("shows no switch when Google is the only source", () => {
    const html = render(google, { posthog: { state: "hidden" }, plausible: { state: "hidden" }, umami: { state: "hidden" } });
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain('name="ga4Property"');
    expect(html).toContain('name="analyticsSource" value="GA4"');
  });

  it("says how to connect a source that isn't connected, and sends nothing for it", () => {
    const html = render(google, { posthog: { state: "connect" }, plausible: { state: "hidden" }, umami: { state: "hidden" } }, { domain: "alphanote.test", analyticsSource: "PostHog" });
    expect(html).toContain("PostHog isn&#x27;t connected yet");
    expect(html).not.toContain('name="posthogProject"');
  });

  it("offers Umami's websites by name and sends the chosen one's id", () => {
    const umami: OtherSourceChoices = {
      posthog: { state: "hidden" },
      plausible: { state: "hidden" },
      umami: { state: "connected", items: [{ id: "4f0c1e2a-0000-4000-8000-00000000abcd", name: "Alphanote", domain: "alphanote.test" }] },
    };
    const html = render(google, umami);
    expect(html).toContain('name="analyticsSource" value="Umami"');
    expect(html).toContain('name="umamiSite"');
    expect(html).toMatch(/<option value="4f0c1e2a-0000-4000-8000-00000000abcd" selected="">Alphanote · alphanote.test<\/option>/);
  });

  it("keeps the connect line, naming both, when Google is the only source and isn't connected", () => {
    const html = render({ state: "connect" }, { posthog: { state: "hidden" }, plausible: { state: "hidden" }, umami: { state: "hidden" } });
    expect(html).toContain("Connect Search Console and Analytics");
    expect(html).not.toContain('name="analyticsSource"');
  });
});
