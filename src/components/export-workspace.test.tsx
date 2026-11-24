import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { exportLabel } from "@/lib/workspace/export-labels";
import { ExportWorkspace } from "./export-workspace";

const tables = ["workspace", "gsc_query_pages", "rank_keywords"].map((name) => ({ name, label: exportLabel(name) }));

describe("ExportWorkspace", () => {
  it("shows each table by its name in words, and asks for it by its own", () => {
    const html = renderToStaticMarkup(<ExportWorkspace tables={tables} />);
    expect(html).toContain('<option value="gsc_query_pages">Search Console: searches by page</option>');
    expect(html).toContain('<option value="rank_keywords">Rankings: tracked keywords</option>');
    // What a person reads: the text between the tags.
    expect(html.replace(/<[^>]*>/g, " ")).not.toContain("_");
  });

  it("calls a table it has no name for yet in words, not its database name", () => {
    expect(exportLabel("some_new_table")).toBe("Some new table");
  });
});
