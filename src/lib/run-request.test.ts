import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => ({ headers: new Headers(), reads: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => {
    request.reads++;
    return request.headers;
  },
}));

const { isSameOrigin, runAllowed, wantsRun } = await import("./run-request");

beforeEach(() => {
  request.headers = new Headers();
  request.reads = 0;
});

describe("isSameOrigin", () => {
  it("is true only for same-origin", () => {
    expect(isSameOrigin("same-origin")).toBe(true);
    expect(isSameOrigin(" Same-Origin ")).toBe(true);
    for (const v of ["cross-site", "same-site", "none", "", null]) expect(isSameOrigin(v)).toBe(false);
  });
});

describe("runAllowed", () => {
  it("doesn't run from another site's link", () => {
    expect(runAllowed("1", "cross-site")).toBe(false);
    expect(runAllowed(["1"], "cross-site")).toBe(false);
  });

  it("runs only from SEOpen's own page", () => {
    expect(runAllowed("1", "same-origin")).toBe(true);
    // A sibling subdomain, an emailed or typed link, and a browser without Fetch Metadata show the Run button.
    for (const v of ["same-site", "none", null]) expect(runAllowed("1", v)).toBe(false);
  });

  it("never runs without run=1", () => {
    for (const run of [undefined, "", "0", "true", ["0", "1"]]) expect(runAllowed(run, "same-origin")).toBe(false);
  });
});

describe("wantsRun", () => {
  it("reads Sec-Fetch-Site from the request", async () => {
    request.headers = new Headers({ "sec-fetch-site": "cross-site" });
    await expect(wantsRun("1")).resolves.toBe(false);
    request.headers = new Headers({ "sec-fetch-site": "same-origin" });
    await expect(wantsRun("1")).resolves.toBe(true);
    request.headers = new Headers({ "sec-fetch-site": "none" });
    await expect(wantsRun("1")).resolves.toBe(false);
    request.headers = new Headers();
    await expect(wantsRun("1")).resolves.toBe(false);
  });

  it("doesn't read the request's headers when nothing asks to run", async () => {
    request.headers = new Headers({ "sec-fetch-site": "same-origin" });
    await expect(wantsRun(undefined)).resolves.toBe(false);
    await expect(wantsRun("0")).resolves.toBe(false);
    expect(request.reads).toBe(0);
  });
});
