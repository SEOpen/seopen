import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/workspace/current", () => ({ currentTimeZone: async () => "UTC" }));

const { ResearchForm, RunPrompt, RunRest } = await import("./research-ui");

const form = (refused?: string) => renderToStaticMarkup(<ResearchForm action="/keywords" q="" placeholder="Enter a keyword" locationCode={2840} costUsd={0.03} freshUsd={0.03} refused={refused} />);

describe("ResearchForm's Analyze while the workspace can't spend", () => {
  it("is off, and says why on the button, so Enter in a field can't submit it either", () => {
    const html = form("This workspace is suspended.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."/);
    // Nothing beside it repeats the banner.
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("suspended");
  });

  it("is on otherwise", () => {
    const html = form();
    expect(html).toMatch(/<button[^>]*type="submit"/);
    expect(html).not.toMatch(/<button[^>]*\bdisabled=""/);
  });
});

describe("RunPrompt's Run while the workspace can't spend", () => {
  const prompt = (refused?: string) => renderToStaticMarkup(<RunPrompt title="“roofing” isn't loaded yet" href="/keywords?q=roofing&run=1" costUsd={0.03} refused={refused} />);

  it("is a button that's off and says why, with no address that runs", () => {
    const html = prompt("This workspace is suspended.");
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."[^>]*>Run \(/);
    expect(html).not.toContain("run=1");
    expect(html).not.toContain("<a ");
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("suspended");
  });

  it("is a link that runs otherwise", () => {
    const html = prompt();
    expect(html).toContain('href="/keywords?q=roofing&amp;run=1"');
    expect(html).not.toContain("<button");
  });
});

describe("RunRest's Load the rest while the workspace can't spend", () => {
  const rest = (refused?: string) => renderToStaticMarkup(<RunRest action="/keywords" params={{ q: "roofing" }} description="Part of “roofing” isn't loaded." costUsd={0.03} refused={refused} />);

  it("is off and says why on the button", () => {
    const html = rest("This workspace is suspended.");
    expect(html).toMatch(/<button[^>]*\bdisabled=""[^>]*title="This workspace is suspended\."[^>]*>Load the rest \(/);
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("suspended");
  });

  it("is on otherwise", () => {
    const html = rest();
    expect(html).toContain("Load the rest (");
    // The hidden submit that keeps Enter from running is always off; the visible one is on.
    expect(html).not.toMatch(/<button(?![^>]*\bhidden="")[^>]*\bdisabled=""/);
  });
});
