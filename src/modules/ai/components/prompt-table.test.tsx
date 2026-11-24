import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PromptTable, type PromptTableRow } from "./prompt-table";

vi.mock("../actions", () => ({ deletePrompts: vi.fn(), setPromptsTopic: vi.fn() }));
vi.mock("@/components/ui/confirm-submit", () => ({
  ConfirmSubmit: ({ children, variant, question }: { children: ReactNode; variant?: string; question: string }) => (
    <button data-variant={variant} data-question={question}>
      {children}
    </button>
  ),
}));

const row: PromptTableRow = {
  id: 1,
  prompt: "best seo tool",
  keyword: null,
  topic: null,
  branded: false,
  active: true,
  platforms: ["chat_gpt"],
  results: {},
  aio: null,
  mentionedOn: 1,
  citedOn: 0,
  checkedOn: 2,
};

describe("the AI Overview cell", () => {
  const cell = (aio: PromptTableRow["aio"]) => {
    const html = renderToStaticMarkup(<PromptTable projectId={1} rows={[{ ...row, keyword: "web design salem nh", aio }]} />);
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  };

  it("says the day of the weekly check it shows, so it can't read as Rankings' daily look", () => {
    expect(cell({ present: false, cited: false, day: "Nov 2" })).toContain("none on Nov 2");
    expect(cell({ present: true, cited: false, day: "Nov 2" })).toContain("shown Nov 2");
    expect(cell({ present: true, cited: true, day: "Nov 2" })).toContain("shown · cited Nov 2");
  });

  it("says a keyword not checked yet waits for the weekly check", () => {
    expect(cell(null)).toContain("not checked yet");
  });
});

describe("sortable heads", () => {
  it("keep a right-aligned label on the column's edge, with no room held for a caret", () => {
    const html = renderToStaticMarkup(<PromptTable projectId={1} rows={[row]} />);
    const at = html.indexOf(">Named on<");
    const th = html.slice(html.lastIndexOf("<th", at), html.indexOf("</th>", at));
    expect(th).toContain("text-right");
    expect(th).toContain("relative");
    expect(th).not.toContain("gap-1");
    expect(th).not.toContain("w-3");
    expect(th).toContain(">Named on</button>");
  });
});

describe("a failed answer", () => {
  const failed = (error: string | null) => renderToStaticMarkup(<PromptTable projectId={1} rows={[{ ...row, results: { chat_gpt: { status: "failed", mentioned: false, cited: false, error } } as never }]} />);

  it("shows its reason in the cell, not only on hover", () => {
    const html = failed("No answer came back in time. Run it again.");
    expect(html).toContain(">failed<");
    expect(html).toContain(">No answer came back in time. Run it again.<");
    expect(html).not.toContain('title="No answer came back');
  });

  it("just says failed with no reason to give", () => {
    expect(failed(null)).toContain(">failed<");
  });
});

describe("deleting one row", () => {
  it("is the row-removal confirm, whose Confirm is the danger button", () => {
    const html = renderToStaticMarkup(<PromptTable projectId={1} rows={[row]} />);
    const at = html.indexOf('data-question="Delete with its answers?"');
    expect(at).toBeGreaterThan(-1);
    expect(html.slice(html.lastIndexOf("<button", at), at)).toContain('data-variant="ghost"');
  });
});
