import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainFailure } from "@/lib/dataforseo/failure-copy";

/** The Plausible client against faked HTTP responses. Every site and number here is made up. */

const KEY = "made-up-stats-key-123";
const account = { id: 1, workspaceId: 7, status: "active", connectedAt: new Date(), lastError: null };
const reject = vi.fn();
vi.mock("./account", () => ({
  fixtureMode: () => false,
  plausibleKey: async () => ({ key: KEY, account }),
  rejectPlausibleKey: (...a: unknown[]) => reject(...a),
}));

const { checkPlausibleKey, livePlausibleApis } = await import("./api");
const { organicLandingQuery, PAGE_ROWS, parseLandingRows, parseSourceRows, sourceSessionsQuery } = await import("./query");
const { PlausibleAccessError, PlausibleNotConnectedError, PlausibleQuotaError } = await import("./types");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SITES = { sites: [{ domain: "made-up.example", timezone: "Europe/London" }], meta: { after: null, before: null, limit: 100 } };

interface Call {
  url: URL;
  init: RequestInit;
  body: Record<string, unknown> | null;
}

/** A fake fetch answering by path, recording what it was asked. */
function fake(answer: (path: string, call: Call) => Response) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { url, init: init ?? {}, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null };
    calls.push(call);
    return answer(url.pathname, call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reject.mockReset();
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the organic landing query", () => {
  it("asks for visits and bounce rate per day and entry page, on the Organic Search channel", () => {
    expect(organicLandingQuery("made-up.example", "2026-10-01", "2026-10-30", 20_000)).toEqual({
      site_id: "made-up.example",
      metrics: ["visits", "bounce_rate"],
      date_range: ["2026-10-01", "2026-10-30"],
      dimensions: ["time:day", "visit:entry_page_hostname", "visit:entry_page"],
      filters: [["is", "visit:channel", ["Organic Search"]]],
      order_by: [
        ["time:day", "asc"],
        ["visit:entry_page_hostname", "asc"],
        ["visit:entry_page", "asc"],
      ],
      pagination: { limit: 10_000, offset: 20_000 },
    });
  });

  it("refuses dates that aren't days", () => {
    expect(() => organicLandingQuery("made-up.example", "today", "2026-10-30")).toThrow(/Bad date range/);
  });

  it("turns results into landing rows, with engaged as not bounced", () => {
    expect(parseLandingRows([{ dimensions: ["2026-10-01", "Made-Up.example", "/pricing"], metrics: [20, 25] }])).toEqual([
      { date: "2026-10-01", hostName: "made-up.example", landingPage: "/pricing", sessions: 20, engagedSessions: 15, keyEvents: 0, totalRevenue: 0 },
    ]);
  });

  it("merges hosts differing only by case, so one row goes in per page and day", () => {
    const rows = parseLandingRows([
      { dimensions: ["2026-10-01", "made-up.example", "/"], metrics: [4, 50] },
      { dimensions: ["2026-10-01", "MADE-UP.example", "/"], metrics: [6, 0] },
    ]);
    expect(rows).toEqual([{ date: "2026-10-01", hostName: "made-up.example", landingPage: "/", sessions: 10, engagedSessions: 8, keyEvents: 0, totalRevenue: 0 }]);
  });

  it("names a missing entry page as GA4 does, and rejects a day that isn't a date", () => {
    expect(parseLandingRows([{ dimensions: ["2026-10-01", "made-up.example", ""], metrics: [1, 100] }])[0].landingPage).toBe("(not set)");
    expect(() => parseLandingRows([{ dimensions: ["soon", "made-up.example", "/"], metrics: [1, 0] }])).toThrow(/isn't a date/);
  });
});

describe("checking a pasted key", () => {
  it("lists the sites, then proves the Stats API answers, sending the key only as a bearer token to Plausible", async () => {
    const { impl, calls } = fake((path) => (path === "/api/v1/sites" ? json(SITES) : json({ results: [{ dimensions: [], metrics: [3] }] })));
    expect(await checkPlausibleKey(KEY, impl)).toEqual({ ok: true, sites: [{ domain: "made-up.example", timezone: "Europe/London" }] });
    expect(calls.map((c) => c.url.origin)).toEqual(["https://plausible.io", "https://plausible.io"]);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/sites", "/api/v2/query"]);
    expect(calls[1].body).toEqual({ site_id: "made-up.example", metrics: ["visits"], date_range: "day" });
    for (const c of calls) {
      expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      expect(c.init.redirect).toBe("error");
      expect(c.url.href).not.toContain(KEY);
    }
  });

  it("accepts a working key that has no sites yet", async () => {
    const { impl, calls } = fake(() => json({ sites: [], meta: { after: null } }));
    expect(await checkPlausibleKey(KEY, impl)).toEqual({ ok: true, sites: [] });
    expect(calls).toHaveLength(1);
  });

  it("follows the cursor through every page of sites", async () => {
    const { impl, calls } = fake((_p, c) =>
      c.url.searchParams.get("after") === "next-page"
        ? json({ sites: [{ domain: "two.example", timezone: "UTC" }], meta: { after: null } })
        : c.url.pathname === "/api/v1/sites"
          ? json({ sites: [{ domain: "one.example", timezone: "UTC" }], meta: { after: "next-page" } })
          : json({ results: [] }),
    );
    const res = await checkPlausibleKey(KEY, impl);
    expect(res.ok && res.sites.map((s) => s.domain)).toEqual(["one.example", "two.example"]);
    expect(calls[1].url.searchParams.get("limit")).toBe("100");
  });

  it.each([
    [401, /didn't accept that key/],
    [402, /doesn't include the Stats API/],
    [429, /limiting requests/],
    [500, /didn't answer/],
  ])("says plainly what a %i means, and never repeats the key or Plausible's text", async (status, message) => {
    const { impl } = fake(() => json({ error: `Refused ${KEY} for made-up reasons` }, status));
    const res = await checkPlausibleKey(KEY, impl);
    expect(res).toEqual({ ok: false, error: expect.stringMatching(message) });
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("fails a key the listing takes but the Stats API refuses", async () => {
    const { impl } = fake((path) => (path === "/api/v1/sites" ? json(SITES) : json({ error: "no access" }, 402)));
    expect(await checkPlausibleKey(KEY, impl)).toEqual({ ok: false, error: expect.stringMatching(/Business plan/) });
  });

  it("fails plainly when Plausible can't be reached", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkPlausibleKey(KEY, impl)).toEqual({ ok: false, error: expect.stringMatching(/didn't answer/) });
  });
});

describe("the live client", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ dimensions: ["2026-10-01", "made-up.example", `/p${i}`], metrics: [2, 50] }));

  it("pages through results until a short page", async () => {
    const { impl, calls } = fake((_p, c) => json({ results: rows((c.body?.pagination as { offset: number }).offset === 0 ? PAGE_ROWS : 2) }));
    const out = await livePlausibleApis(7, impl).organicLandingPages("made-up.example", "2026-10-01", "2026-10-30");
    expect(calls.map((c) => (c.body?.pagination as { offset: number }).offset)).toEqual([0, PAGE_ROWS]);
    expect(out).toHaveLength(PAGE_ROWS);
  });

  it("reads one site's time zone, with its id encoded into the path", async () => {
    const { impl, calls } = fake(() => json({ domain: "made-up.example/blog", timezone: "Asia/Tokyo" }));
    expect(await livePlausibleApis(7, impl).site("made-up.example/blog")).toEqual({ domain: "made-up.example/blog", timezone: "Asia/Tokyo" });
    expect(calls[0].url.pathname).toBe("/api/v1/sites/made-up.example%2Fblog");
  });

  it("marks the key refused when the listing says 401 too", async () => {
    const { impl } = fake(() => json({ error: "Invalid API key" }, 401));
    const err = await livePlausibleApis(7, impl).organicLandingPages("made-up.example", "2026-10-01", "2026-10-30").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlausibleNotConnectedError);
    expect(reject).toHaveBeenCalledOnce();
    expect(plainFailure(err)).toEqual({ title: "Plausible isn't connected", message: "Plausible needs reconnecting.", retry: false });
  });

  it("leaves the key alone when a 401 is only about this site, since it still lists others", async () => {
    const { impl } = fake((path) => (path === "/api/v1/sites" ? json(SITES) : json({ error: "Invalid API key or site ID" }, 401)));
    const err = await livePlausibleApis(7, impl).organicLandingPages("someone-elses.example", "2026-10-01", "2026-10-30").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlausibleAccessError);
    expect(reject).not.toHaveBeenCalled();
    expect(plainFailure(err).retry).toBe(false);
  });

  it("leaves the key alone when Plausible can't be reached to tell", async () => {
    let first = true;
    const impl = vi.fn(async () => {
      if (first) {
        first = false;
        return json({ error: "Invalid API key or site ID" }, 401);
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await livePlausibleApis(7, impl).site("made-up.example").catch(() => {});
    expect(reject).not.toHaveBeenCalled();
  });

  it("reads a 402 as no Stats API, with no retry and Plausible's reason in the logs", async () => {
    const { impl } = fake(() => json({ error: "The account that owns this API key does not have access to Stats API" }, 402));
    const err = await livePlausibleApis(7, impl).site("made-up.example").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlausibleAccessError);
    expect(plainFailure(err)).toMatchObject({ retry: false, message: expect.stringMatching(/Business plan/) });
    expect(log).toHaveBeenCalledWith("[plausible] 402:", expect.stringMatching(/does not have access/));
    expect(reject).not.toHaveBeenCalled();
  });

  it("reads a 429 as a rate limit", async () => {
    const { impl } = fake(() => json({ error: "Too many API requests" }, 429));
    const err = await livePlausibleApis(7, impl).site("made-up.example").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlausibleQuotaError);
    expect(plainFailure(err)).toEqual({ title: "Plausible is limiting requests", message: "Try again in a few minutes.", retry: true });
  });

  it("takes the key out of any error text, even if a response repeats it", async () => {
    const { impl } = fake(() => json({ error: `Bad request for ${KEY}` }, 400));
    const err = (await livePlausibleApis(7, impl).site("made-up.example").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("Plausible API error 400: Bad request for [key]");
    const limited = fake(() => json({ error: `Slow down ${KEY}` }, 429));
    const quota = (await livePlausibleApis(7, limited.impl).site("made-up.example").catch((e: unknown) => e)) as Error;
    expect(quota.message).not.toContain(KEY);
  });
});

describe("visits by source, for AI assistants", () => {
  it("asks for every visit by source, largest first, with no channel filter", () => {
    expect(sourceSessionsQuery("made-up.example", "2026-10-01", "2026-10-28")).toEqual({
      site_id: "made-up.example",
      metrics: ["visits", "bounce_rate"],
      date_range: ["2026-10-01", "2026-10-28"],
      dimensions: ["visit:source"],
      order_by: [["visits", "desc"]],
      pagination: { limit: 10_000, offset: 0 },
    });
    expect(() => sourceSessionsQuery("made-up.example", "2026-10-01", "now")).toThrow(/Bad date range/);
  });

  it("turns rows into sources with engaged as not bounced", () => {
    expect(parseSourceRows([{ dimensions: ["ChatGPT"], metrics: [10, 40] }, { dimensions: [null], metrics: [3, 0] }])).toEqual([
      { sources: ["ChatGPT"], sessions: 10, engagedSessions: 6 },
      { sources: [null], sessions: 3, engagedSessions: 3 },
    ]);
  });

  it("posts the query to the Stats API with the stored key", async () => {
    const { impl, calls } = fake(() => json({ results: [{ dimensions: ["perplexity.ai"], metrics: [4, 25] }] }));
    expect(await livePlausibleApis(7, impl).sourceSessions("made-up.example", "2026-10-01", "2026-10-28")).toEqual([{ sources: ["perplexity.ai"], sessions: 4, engagedSessions: 3 }]);
    expect(calls[0].url.pathname).toBe("/api/v2/query");
    expect(calls[0].body?.dimensions).toEqual(["visit:source"]);
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });
});
