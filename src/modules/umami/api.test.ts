import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainFailure } from "@/lib/dataforseo/failure-copy";

/** The Umami client against faked HTTP responses. Every website, key and number here is made up. */

const KEY = "umami_made-up-key-123";
const account = { id: 1, workspaceId: 7, baseUrl: null as string | null, authType: "api_key", status: "active", connectedAt: new Date(), lastError: null };
const reject = vi.fn();
vi.mock("./account", () => ({
  fixtureMode: () => false,
  umamiCredential: async () => ({ credential: KEY, account }),
  rejectUmamiCredential: (...a: unknown[]) => reject(...a),
}));

const { checkUmami, liveUmamiApis, loginUmami, umamiClient } = await import("./api");
const { dayWindow, hostOf, isSearchReferrer, organicEntryParams, PAGE_ROWS, parseDay, parseSourceRows, SEARCH_REFERRER, SOURCE_PAGES, sourceParams } = await import("./query");
const { apiRoot, cloudTransport, normalizeUmamiServer, selfHostedTransport } = await import("./server");
const { UMAMI_CLOUD_API, UmamiAccessError, UmamiNotConnectedError, UmamiQuotaError, UmamiUnreachableError } = await import("./types");
type Transport = import("./server").UmamiTransport;
type Req = Parameters<Transport>[0];

const SITE = { id: "4f0c1e2a-0000-4000-8000-00000000abcd", name: "Made Up", domain: "made-up.example" };
// A real public suffix, since a self-hosted address has to be public. Nothing here connects to it.
const SERVER = "https://stats.madeup-umami.app";

/** A fake transport answering by path, recording what it was asked. */
function fake(answer: (path: string, url: URL, req: Req) => { status?: number; body: unknown }) {
  const calls: (Req & { parsed: URL })[] = [];
  const transport: Transport = async (req) => {
    const parsed = new URL(req.url);
    calls.push({ ...req, parsed });
    const { status = 200, body } = answer(parsed.pathname, parsed, req);
    return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  };
  return { transport, calls };
}

/** Umami Cloud's answers for one website with traffic. */
const cloud = (overrides: Partial<Record<string, { status?: number; body: unknown }>> = {}) =>
  fake((path, url) => {
    const rel = path.replace(/^\/v1/, "");
    if (overrides[rel]) return overrides[rel]!;
    if (rel === "/websites") return { body: { data: [SITE], count: 1, page: 1, pageSize: 100 } };
    if (rel === `/websites/${SITE.id}`) return { body: SITE };
    if (rel === `/websites/${SITE.id}/metrics`) return { body: [{ x: "www.google.com", y: 12 }, { x: "news.example", y: 3 }] };
    if (rel === `/websites/${SITE.id}/stats`) return { body: { pageviews: 30, visitors: 9, visits: 10, bounces: 4, totaltime: 100 } };
    if (rel === `/websites/${SITE.id}/metrics/expanded`) {
      const engaged = url.searchParams.has("excludeBounce");
      return { body: [{ name: "/pricing", pageviews: 20, visitors: 9, visits: engaged ? 6 : 10, bounces: 0, totaltime: 0 }] };
    }
    return { status: 404, body: { error: { code: "not-found", message: "Not found.", status: 404 } } };
  });

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  reject.mockReset();
  account.baseUrl = null;
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a self-hosted server's address", () => {
  it("is blank for Umami Cloud, and Cloud's own hosts connect as Cloud", () => {
    expect(normalizeUmamiServer("  ")).toEqual({ ok: true, baseUrl: null });
    expect(normalizeUmamiServer("https://cloud.umami.is")).toEqual({ ok: true, baseUrl: null });
  });

  it("keeps https, the host and a mount path, and drops a trailing /api", () => {
    expect(normalizeUmamiServer("stats.madeup-umami.app")).toEqual({ ok: true, baseUrl: SERVER });
    expect(normalizeUmamiServer("https://Stats.MadeUp-Umami.app/umami/api/?x=1")).toEqual({ ok: true, baseUrl: "https://stats.madeup-umami.app/umami" });
  });

  it("refuses plain http, other ports, logins, IPs and private names, so the credential only goes to a public https host", () => {
    for (const bad of ["http://stats.madeup-umami.app", "https://stats.madeup-umami.app:3000", "https://me:pw@stats.madeup-umami.app", "https://127.0.0.1", "https://10.0.0.5", "https://localhost", "https://umami.internal", "https://[::1]"]) {
      expect(normalizeUmamiServer(bad).ok, bad).toBe(false);
    }
  });

  it("puts the API under /api, and Cloud's under its own root", () => {
    expect(apiRoot(SERVER)).toBe(`${SERVER}/api`);
    expect(apiRoot(null)).toBe("https://api.umami.is/v1");
  });
});

describe("the transports", () => {
  it("sends Cloud requests to Cloud's API only, following no redirect", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    await cloudTransport(fetchImpl)({ url: `${UMAMI_CLOUD_API}/websites`, method: "GET", headers: {} });
    expect(vi.mocked(fetchImpl).mock.calls[0][1]).toMatchObject({ redirect: "error" });
    await expect(cloudTransport(fetchImpl)({ url: "https://elsewhere.example/v1/websites", method: "GET", headers: {} })).rejects.toThrow(/Umami Cloud requests go to its API only/);
  });

  it("won't connect a self-hosted request to a private address", async () => {
    await expect(selfHostedTransport({ url: "https://localhost/api/websites", method: "GET", headers: { authorization: `Bearer ${KEY}` } })).rejects.toBeInstanceOf(UmamiUnreachableError);
    await expect(selfHostedTransport({ url: "https://127.0.0.1/api/websites", method: "GET", headers: {} })).rejects.toThrow(/isn't a public website/);
  });
});

describe("the organic entry query", () => {
  it("asks for one UTC day of entry pages from search sites, a page at a time", () => {
    const p = organicEntryParams("2026-10-01", 500, false);
    expect(Object.fromEntries(p)).toEqual({
      type: "entry",
      startAt: String(Date.parse("2026-10-01T00:00:00Z")),
      endAt: String(Date.parse("2026-10-02T00:00:00Z") - 1),
      timezone: "UTC",
      referrer: `re.${SEARCH_REFERRER}`,
      limit: String(PAGE_ROWS),
      offset: "500",
    });
    expect(organicEntryParams("2026-10-01", 0, true).get("excludeBounce")).toBe("1");
  });

  it("refuses a day that isn't a date", () => {
    expect(() => dayWindow("today")).toThrow(/Bad day/);
  });

  it("matches the search sites Umami counts, and not others", () => {
    for (const d of ["google.com", "www.google.co.uk", "bing.com", "duckduckgo.com", "search.brave.com", "yandex.ru", "ecosia.org", "baidu.com", "msn.com"]) expect(isSearchReferrer(d), d).toBe(true);
    for (const d of ["made-up.example", "notgoogle.example", "chatgpt.com", "brave.com", "facebook.com", ""]) expect(isSearchReferrer(d), d).toBe(false);
  });

  it("turns a day's visits into landing rows under the website's host, with engaged as not bounced", () => {
    expect(parseDay("2026-10-01", hostOf("https://Made-Up.example/"), [{ name: "/pricing", visits: 10 }, { name: "", visits: 2 }, { name: "/gone", visits: 0 }], [{ name: "/pricing", visits: 6 }, { name: "/elsewhere", visits: 3 }])).toEqual([
      { date: "2026-10-01", hostName: "made-up.example", landingPage: "/pricing", sessions: 10, engagedSessions: 6, keyEvents: 0, totalRevenue: 0 },
      { date: "2026-10-01", hostName: "made-up.example", landingPage: "(not set)", sessions: 2, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 },
    ]);
  });
});

describe("checkUmami", () => {
  it("lists the websites with an API key, sending it as a bearer token (and Cloud's older header)", async () => {
    const { transport, calls } = cloud();
    await expect(checkUmami({ baseUrl: null, authType: "api_key", credential: KEY }, transport, 0)).resolves.toEqual({ ok: true, sites: [SITE] });
    expect(calls[0].parsed.origin + calls[0].parsed.pathname).toBe(`${UMAMI_CLOUD_API}/websites`);
    expect(calls[0].parsed.searchParams.get("includeTeams")).toBe("true");
    expect(calls[0].headers).toMatchObject({ authorization: `Bearer ${KEY}`, "x-umami-api-key": KEY });
    // The filter check: search referrers were listed, so the filtered count had to find visits.
    expect(calls.map((c) => c.parsed.pathname)).toEqual(["/v1/websites", `/v1/websites/${SITE.id}/metrics`, `/v1/websites/${SITE.id}/stats`]);
    expect(calls[2].parsed.searchParams.get("referrer")).toBe(`re.${SEARCH_REFERRER}`);
  });

  it("sends a self-hosted key to the server's /api, and only the bearer header", async () => {
    const { transport, calls } = fake((path) => (path === "/api/websites" ? { body: { data: [], count: 0 } } : { status: 404, body: "" }));
    await expect(checkUmami({ baseUrl: SERVER, authType: "api_key", credential: KEY }, transport, 0)).resolves.toEqual({ ok: true, sites: [] });
    expect(calls[0].url.startsWith(`${SERVER}/api/websites?`)).toBe(true);
    expect(calls[0].headers).not.toHaveProperty("x-umami-api-key");
  });

  it("follows the website list's pages", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, name: `Site ${i}`, domain: `s${i}.example` }));
    const { transport, calls } = fake((path, url) => (path === "/v1/websites" ? { body: url.searchParams.get("page") === "1" ? { data: many, count: 101 } : { data: [SITE], count: 101 } } : { body: [] }));
    const r = await checkUmami({ baseUrl: null, authType: "api_key", credential: KEY }, transport, 0);
    expect(r.ok && r.sites.length).toBe(101);
    expect(calls.filter((c) => c.parsed.pathname === "/v1/websites").map((c) => c.parsed.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("refuses a server that doesn't apply the search filter, rather than syncing no visits", async () => {
    const { transport } = cloud({ [`/websites/${SITE.id}/stats`]: { body: { visits: 0 } } });
    const r = await checkUmami({ baseUrl: null, authType: "api_key", credential: KEY }, transport, 0);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/didn't apply SEOpen's search filter/) });
  });

  it("skips the filter check when no search site has sent visits yet", async () => {
    const { transport, calls } = cloud({ [`/websites/${SITE.id}/metrics`]: { body: [{ x: "news.example", y: 3 }] } });
    expect((await checkUmami({ baseUrl: null, authType: "api_key", credential: KEY }, transport, 0)).ok).toBe(true);
    expect(calls.some((c) => c.parsed.pathname.endsWith("/stats"))).toBe(false);
  });

  it("explains a refused key in our words, never repeating it or Umami's text", async () => {
    const { transport } = cloud({ "/websites": { status: 401, body: { error: { message: `bad key ${KEY}` } } } });
    const r = await checkUmami({ baseUrl: null, authType: "api_key", credential: KEY }, transport, 0);
    expect(r).toEqual({ ok: false, error: "Umami didn't accept that API key. Copy it again from Settings, API keys." });
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("says when a self-hosted address isn't an Umami server", async () => {
    const { transport } = fake(() => ({ body: "<!doctype html><title>Hello</title>" }));
    expect(await checkUmami({ baseUrl: SERVER, authType: "api_key", credential: KEY }, transport, 0)).toEqual({ ok: false, error: expect.stringMatching(/not as an Umami server/) });
  });

  it("passes on why a self-hosted server couldn't be reached", async () => {
    const transport: Transport = async () => {
      throw new UmamiUnreachableError("SEOpen couldn't reach your Umami server. Its domain isn't in DNS.");
    };
    expect(await checkUmami({ baseUrl: SERVER, authType: "api_key", credential: KEY }, transport, 0)).toEqual({ ok: false, error: "SEOpen couldn't reach your Umami server. Its domain isn't in DNS." });
  });
});

describe("loginUmami", () => {
  it("posts the login once to the server's /api/auth/login and keeps only the token", async () => {
    const { transport, calls } = fake(() => ({ body: { token: "made-up-token", user: { id: "u1", username: "me" } } }));
    await expect(loginUmami(SERVER, "me", "made-up-password", transport)).resolves.toEqual({ ok: true, token: "made-up-token" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${SERVER}/api/auth/login`, method: "POST" });
    expect(JSON.parse(calls[0].body!)).toEqual({ username: "me", password: "made-up-password" });
  });

  it("asks for an API key when the user signs in with two factors", async () => {
    const { transport } = fake(() => ({ body: { requiresTwoFactor: true, partialToken: "partial" } }));
    expect(await loginUmami(SERVER, "me", "pw", transport)).toEqual({ ok: false, error: expect.stringMatching(/two-factor/) });
  });

  it("says a wrong login plainly", async () => {
    const { transport } = fake(() => ({ status: 401, body: { error: { message: "Unauthorized." } } }));
    expect(await loginUmami(SERVER, "me", "pw", transport)).toEqual({ ok: false, error: "Your Umami server didn't accept that username and password." });
  });
});

describe("liveUmamiApis", () => {
  it("reads a website and its organic landing pages, a pair of requests a day", async () => {
    const { transport, calls } = cloud();
    const api = liveUmamiApis(7, transport, 0);
    const site = await api.site(SITE.id);
    expect(site).toEqual(SITE);
    const rows = await api.organicLandingPages(site, "2026-10-01", "2026-10-02");
    expect(rows).toEqual([
      { date: "2026-10-01", hostName: "made-up.example", landingPage: "/pricing", sessions: 10, engagedSessions: 6, keyEvents: 0, totalRevenue: 0 },
      { date: "2026-10-02", hostName: "made-up.example", landingPage: "/pricing", sessions: 10, engagedSessions: 6, keyEvents: 0, totalRevenue: 0 },
    ]);
    expect(calls.filter((c) => c.parsed.pathname.endsWith("/metrics/expanded"))).toHaveLength(4);
  });

  it("asks for the next page while a page comes back full", async () => {
    const full = Array.from({ length: PAGE_ROWS }, (_, i) => ({ name: `/p${i}`, visits: 1 }));
    const { transport } = cloud();
    const paged: Transport = async (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/metrics/expanded")) return { status: 200, body: JSON.stringify(u.searchParams.get("offset") === "0" ? full : [{ name: "/last", visits: 2 }]) };
      return transport(req);
    };
    const rows = await liveUmamiApis(7, paged, 0).organicLandingPages(SITE, "2026-10-01", "2026-10-01");
    expect(rows).toHaveLength(PAGE_ROWS + 1);
  });

  it("marks the connection for a reconnect when Umami refuses the credential itself", async () => {
    const { transport } = cloud({ "/websites": { status: 401, body: "" }, [`/websites/${SITE.id}`]: { status: 401, body: "" } });
    await expect(liveUmamiApis(7, transport, 0).site(SITE.id)).rejects.toEqual(new UmamiNotConnectedError("reauth_required"));
    expect(reject).toHaveBeenCalledWith(account);
  });

  it("keeps the connection when only the website is out of reach", async () => {
    const { transport } = cloud({ [`/websites/${SITE.id}`]: { status: 401, body: "" } });
    await expect(liveUmamiApis(7, transport, 0).site(SITE.id)).rejects.toBeInstanceOf(UmamiAccessError);
    expect(reject).not.toHaveBeenCalled();
    const gone = cloud({ [`/websites/${SITE.id}`]: { body: null } });
    await expect(liveUmamiApis(7, gone.transport, 0).site(SITE.id)).rejects.toBeInstanceOf(UmamiAccessError);
  });

  it("backs off on a rate limit", async () => {
    const { transport } = cloud({ [`/websites/${SITE.id}/metrics/expanded`]: { status: 429, body: "" } });
    await expect(liveUmamiApis(7, transport, 0).organicLandingPages(SITE, "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(UmamiQuotaError);
  });

  it("takes the credential out of anything Umami says back", async () => {
    const { transport } = cloud({ "/websites": { status: 500, body: { error: { message: `boom ${KEY}` } } } });
    const err = await liveUmamiApis(7, transport, 0).sites().catch((e: Error) => e);
    expect(String(err)).toContain("[credential]");
    expect(String(err)).not.toContain(KEY);
  });

  it("spaces its requests to stay inside Cloud's rate limit", async () => {
    const { transport } = cloud();
    const client = umamiClient({ baseUrl: null, authType: "api_key", credential: KEY }, transport, 40);
    const started = Date.now();
    await client.sites();
    await client.sites();
    await client.sites();
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });
});

describe("plain failure copy", () => {
  it("names Umami's own problems", () => {
    expect(plainFailure(new UmamiAccessError()).title).toBe("No access to that Umami website");
    expect(plainFailure(new UmamiNotConnectedError("reauth_required")).message).toBe("Umami needs reconnecting.");
    expect(plainFailure(new UmamiQuotaError("x")).retry).toBe(true);
    expect(plainFailure(new UmamiUnreachableError("SEOpen couldn't reach your Umami server. It refused the connection.")).message).toMatch(/refused the connection/);
  });
});

describe("visits by referrer, for AI assistants", () => {
  it("asks for the whole range by referrer, in UTC, a page at a time", () => {
    const p = sourceParams("2026-10-01", "2026-10-28", 500);
    expect(Object.fromEntries(p)).toEqual({
      type: "referrer",
      startAt: String(dayWindow("2026-10-01").startAt),
      endAt: String(dayWindow("2026-10-28").endAt),
      timezone: "UTC",
      limit: String(PAGE_ROWS),
      offset: "500",
    });
    expect(p.has("referrer")).toBe(false);
  });

  it("counts engaged visits as the ones that didn't bounce", () => {
    expect(parseSourceRows([{ name: "chatgpt.com", visits: 9, bounces: 4 }, { name: "", visits: 2, bounces: 5 }])).toEqual([
      { sources: ["chatgpt.com"], sessions: 9, engagedSessions: 5 },
      { sources: [null], sessions: 2, engagedSessions: 0 },
    ]);
  });

  it("reads the referrer report, stopping at a short page or after SOURCE_PAGES pages", async () => {
    const { transport, calls } = cloud({ [`/websites/${SITE.id}/metrics/expanded`]: { body: [{ name: "claude.ai", visits: 3, bounces: 1 }] } });
    expect(await liveUmamiApis(7, transport, 0).sourceSessions(SITE.id, "2026-10-01", "2026-10-28")).toEqual([{ sources: ["claude.ai"], sessions: 3, engagedSessions: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].parsed.searchParams.get("type")).toBe("referrer");

    const full = Array.from({ length: PAGE_ROWS }, (_, i) => ({ name: `r${i}.example`, visits: 1, bounces: 0 }));
    const many = cloud({ [`/websites/${SITE.id}/metrics/expanded`]: { body: full } });
    expect(await liveUmamiApis(7, many.transport, 0).sourceSessions(SITE.id, "2026-10-01", "2026-10-28")).toHaveLength(PAGE_ROWS * SOURCE_PAGES);
    expect(many.calls).toHaveLength(SOURCE_PAGES);
  });
});
