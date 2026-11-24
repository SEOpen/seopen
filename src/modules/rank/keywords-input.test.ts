import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./db-errors";
import { capNewKeywords, normalizeKeywords, parseKeywordList } from "./parse";

describe("normalizeKeywords", () => {
  it("merges case and whitespace variants, the same way pasted text is merged", () => {
    const fromList = normalizeKeywords(["Mac Journal", "mac  journal", " Daily Notes ", ""]);
    expect(fromList).toEqual(["mac journal", "daily notes"]);
    expect(parseKeywordList("Mac Journal\nmac  journal, Daily Notes")).toEqual(fromList);
  });
});

describe("capNewKeywords", () => {
  it("caps only keywords that aren't tracked yet", () => {
    const r = capNewKeywords(["a", "b", "c", "d"], new Set(["b"]), 2);
    expect(r).toEqual({ keywords: ["a", "b", "c"], added: 2, skipped: 1 });
  });

  it("lets a second add of the same list pick up the rest", () => {
    const list = ["a", "b", "c", "d"];
    const first = capNewKeywords(list, new Set(), 2);
    const second = capNewKeywords(list, new Set(first.keywords), 2);
    expect(second).toEqual({ keywords: list, added: 2, skipped: 0 });
  });
});

describe("isUniqueViolation", () => {
  const pg = { code: "23505", constraint_name: "rank_runs_one_active_per_project" };

  it("finds the driver error inside Drizzle's wrapper", () => {
    expect(isUniqueViolation(pg)).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("Failed query"), { cause: pg }), "rank_runs_one_active_per_project")).toBe(
      true,
    );
  });

  it("ignores other constraints and other errors", () => {
    expect(isUniqueViolation(pg, "rank_keywords_project_id_keyword_device_index")).toBe(false);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
