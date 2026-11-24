import { describe, expect, it } from "vitest";
import { cacheable, cacheKey, DataForSEOError, defaultServerRetries, firstResult, stableStringify, taskResults, type DfsResponse } from "./client";

function response(task: Partial<DfsResponse["tasks"][number]>): DfsResponse<{ n: number }> {
  return {
    status_code: 20000,
    status_message: "Ok.",
    cost: 0.01,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [{ id: "1", status_code: 20000, status_message: "Ok.", cost: 0.01, result_count: 1, path: ["a"], data: {}, result: [{ n: 1 }], ...task }],
  } as DfsResponse<{ n: number }>;
}

describe("stableStringify", () => {
  it("sorts keys and drops undefined", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: undefined, e: "x" }] })).toBe('{"a":[{"d":2,"e":"x"}],"b":1}');
  });
});

describe("cacheKey", () => {
  it("is order-insensitive for object keys and ignores a v3/ prefix", () => {
    expect(cacheKey("POST", "/v3/x/live", [{ a: 1, b: 2 }])).toBe(cacheKey("POST", "x/live", [{ b: 2, a: 1 }]));
  });
  it("differs by body and method", () => {
    expect(cacheKey("POST", "x", [{ a: 1 }])).not.toBe(cacheKey("POST", "x", [{ a: 2 }]));
    expect(cacheKey("GET", "x")).not.toBe(cacheKey("POST", "x"));
  });
});

describe("taskResults", () => {
  it("returns results of a successful task", () => {
    expect(firstResult(response({}))).toEqual({ n: 1 });
  });
  it("treats 40102 no-results as empty", () => {
    expect(taskResults(response({ status_code: 40102, result: null }))).toEqual([]);
  });
  it("throws on a failed task", () => {
    expect(() => taskResults(response({ status_code: 40501, status_message: "Invalid Field" }))).toThrow(DataForSEOError);
  });
});

describe("defaultServerRetries", () => {
  it("never retries task_post on 5xx, retries everything else", () => {
    expect(defaultServerRetries("on_page/task_post")).toBe(0);
    expect(defaultServerRetries("/v3/serp/google/organic/task_post")).toBe(0);
    expect(defaultServerRetries("serp/google/organic/task_get/regular/abc")).toBe(2);
    expect(defaultServerRetries("dataforseo_labs/google/ranked_keywords/live")).toBe(2);
  });
});

describe("cacheable", () => {
  it("keeps a response whose tasks worked or found nothing", () => {
    expect(cacheable(response({ status_code: 20000 }))).toBe(true);
    expect(cacheable(response({ status_code: 40102 }))).toBe(true);
  });

  it("drops one whose task failed, even when the response says 20000 with no task errors", () => {
    expect(cacheable(response({ status_code: 40101, status_message: "Internal SE Server Error." }))).toBe(false);
  });

  it("drops a failed request", () => {
    expect(cacheable({ ...response({}), status_code: 50000 })).toBe(false);
  });
});
