import { describe, expect, it } from "vitest";
import { homeTitle } from "@/app/(app)/home-title";
import { noProjectCopy } from "./no-project-copy";

describe("the empty workspace", () => {
  it("offers Free what Free has, and nothing it doesn't", () => {
    const { description } = noProjectCopy(true);
    expect(description).toContain("site audit");
    expect(description).toContain("fixes");
    expect(description).toContain("Search Console");
    expect(description).not.toMatch(/rank|competitor|keyword|backlink|AI visibility/i);
  });

  it("leads with the same on a paid plan, then adds what the plan tracks", () => {
    const { description } = noProjectCopy(false);
    expect(description.indexOf("site audit")).toBeLessThan(description.indexOf("rankings"));
    expect(description).toContain("competitors");
  });

  it("asks for a project the same way on every plan", () => {
    expect(noProjectCopy(true).title).toBe(noProjectCopy(false).title);
  });
});

describe("the home page title", () => {
  it("names what the page shows for the number of projects", () => {
    expect(homeTitle(0)).toBe("Get started");
    expect(homeTitle(1)).toBe("Overview");
    expect(homeTitle(2)).toBe("All projects");
    expect(homeTitle(9)).toBe("All projects");
  });
});
