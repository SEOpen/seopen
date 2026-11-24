import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmQuestion } from "./confirm-submit";
import { PageHeader } from "./page-header";

const open = renderToStaticMarkup(
  <ConfirmQuestion question="Run 3 prompts now?" confirmLabel="Run" variant="secondary" size="md" label="Run" onConfirm={() => {}} onCancel={() => {}}>
    Run now
  </ConfirmQuestion>,
);
const buttons = open.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];

describe("ConfirmSubmit's open question", () => {
  it("keeps the button's room in a page header with an inert copy, which is gone everywhere else", () => {
    const copy = buttons[0];
    expect(copy).toContain(">Run now<");
    expect(copy).toMatch(/type="button"/);
    expect(copy).toMatch(/\bdisabled=""/);
    expect(copy).toMatch(/aria-hidden="true"/);
    expect(copy).toMatch(/tabindex="-1"/i);
    expect(copy).toMatch(/class="[^"]*\bhidden\b[^"]*in-\[\[data-page-header\]\]:inline-flex/);
    expect(copy).not.toMatch(/class="inline-flex|\sinline-flex\s/);
  });

  it("floats under the header's row in a header, and stays in the line elsewhere", () => {
    const group = open.match(/<span role="group"[^>]*>/)![0];
    expect(group).toContain("in-[[data-page-header]]:absolute");
    expect(group).toContain("in-[[data-page-header]]:top-full");
    expect(group).not.toMatch(/class="[^"]*(?<!:)\babsolute\b/);
  });

  it("leaves Confirm the form's only submit button, so Enter still confirms", () => {
    const submits = buttons.filter((b) => b.includes('type="submit"'));
    expect(submits).toHaveLength(1);
    expect(submits[0]).toContain(">Run<");
  });

  it("has a header to float against", () => {
    const html = renderToStaticMarkup(<PageHeader title="AI visibility" actions={<button>Run now</button>} />);
    expect(html).toMatch(/<div data-page-header="true" class="relative /);
  });
});
