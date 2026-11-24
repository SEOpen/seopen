import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ShellData } from "@/lib/shell";
import { rules } from "@/plan-policy/rules";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/3" }));
vi.mock("./shown-project", () => ({ useShownProject: () => null }));

const { LockedNotice } = await import("./locked-notice");

/** A shell promise React's `use` reads at once, as it would after the layout resolved it. */
const shell = (locked: boolean) => {
  const data = { projects: [{ id: 3, name: "Mill Town", domain: "milltown.com", locked }], currentId: 3 } as unknown as ShellData;
  return Object.assign(Promise.resolve(data), { status: "fulfilled", value: data });
};
const text = (locked: boolean) => renderToStaticMarkup(<LockedNotice shell={shell(locked)} />).replace(/&#x27;/g, "'");

describe("the read-only notice", () => {
  it("says nothing about a project that isn't locked", () => {
    expect(text(false)).toBe("");
  });

  it.skipIf(!rules.hasPlans)("names the plan and links to Billing on getseopen.com", () => {
    const html = text(true);
    expect(html).toContain("because your plan has fewer projects than this workspace holds. To edit and check it again, archive another project or upgrade in ");
    expect(html).toMatch(/<a [^>]*href="\/billing"[^>]*>Billing<\/a>\.<\/p>/);
  });

  it.skipIf(rules.hasPlans)("names no plan and links nowhere on a copy without plans", () => {
    const html = text(true);
    expect(html).toContain("This project's data stays, but nothing new runs for it. To edit and check it again, archive another project.");
    expect(html).not.toMatch(/plan|Billing|href=/);
  });
});
