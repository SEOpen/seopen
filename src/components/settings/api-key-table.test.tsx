import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyTable } from "./api-key-table";

vi.mock("@/app/actions/api-keys", () => ({ revokeApiKeyAction: vi.fn() }));

const html = renderToStaticMarkup(
  <ApiKeyTable rows={[{ id: 1, name: "Claude Code on my laptop", prefix: "seopen_abc", access: "Read and make changes", createdAt: new Date("2026-11-09T12:00:00Z"), lastUsedAt: null }]} />,
);
const headers = html.match(/<th[^>]*>.*?<\/th>/g) ?? [];
const header = (label: string) => headers.find((h) => h.includes(`>${label}<`))!;

describe("ApiKeyTable at a phone's width", () => {
  it("leaves the key's start, what it can do and when it was made to wider screens", () => {
    for (const label of ["Key", "Can", "Made"]) expect(header(label)).toMatch(/\bhidden @2xl\/main:table-cell\b/);
    for (const label of ["Name", "Last used"]) expect(header(label)).not.toMatch(/\bhidden\b/);
  });

  it("keeps what a key can do under its name there, so nothing is lost", () => {
    expect(html).toMatch(/<span class="[^"]*@2xl\/main:hidden[^"]*">Read and make changes<\/span>/);
  });

  it("gives the name room and breaks it between words, not every few letters", () => {
    expect(html).not.toContain("overflow-wrap:anywhere");
    expect(html).toMatch(/class="[^"]*min-w-32[^"]*break-words/);
  });

  it("lets a last-used date break there, and keeps it on one line on wider screens", () => {
    const used = renderToStaticMarkup(<ApiKeyTable rows={[{ id: 2, name: "Cursor", prefix: "seopen_def", access: "Read only", createdAt: new Date(), lastUsedAt: new Date("2026-11-09T12:00:00Z") }]} />);
    expect(used).toMatch(/<span class="@2xl\/main:whitespace-nowrap"><span class="data">/);
  });
});
