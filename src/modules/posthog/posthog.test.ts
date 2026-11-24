import { beforeEach, describe, expect, it, vi } from "vitest";

const account = { id: 1, workspaceId: 7, region: "us", scopedTeams: [] as number[] };
const reject = vi.fn();
vi.mock("./account", () => ({
  fixtureMode: () => false,
  posthogAccessToken: async () => ({ token: "pha_test", account }),
  rejectPosthogToken: (...a: unknown[]) => reject(...a),
}));
vi.mock("@/lib/hosts", () => ({ appOrigin: () => "https://app.example.com" }));

const { livePosthogApis } = await import("./api");
const { organicLandingQuery, parseLandingRows, ROW_LIMIT } = await import("./hogql");
const { authorizeUrl, clientMetadata, oauthAvailable } = await import("./oauth");
const { PosthogNotConnectedError, PosthogQuotaError } = await import("./types");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  account.scopedTeams = [];
  reject.mockReset();
});

describe("OAuth client", () => {
  it("serves a metadata document whose client_id is its own URL", () => {
    const m = clientMetadata();
    expect(m.client_id).toBe("https://app.example.com/api/posthog/client-metadata");
    expect(m.redirect_uris).toEqual(["https://app.example.com/api/posthog/callback"]);
    expect(m.token_endpoint_auth_method).toBe("none");
    expect(m["com.posthog"].scopes).toEqual(["project:read", "query:read"]);
    expect(oauthAvailable()).toBe(true);
  });

  it("sends consent to the chosen region with PKCE", () => {
    const url = new URL(authorizeUrl("eu", { state: "s1", codeChallenge: "c1" }));
    expect(url.origin + url.pathname).toBe("https://eu.posthog.com/oauth/authorize/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "https://app.example.com/api/posthog/client-metadata",
      scope: "project:read query:read",
      state: "s1",
      code_challenge: "c1",
      code_challenge_method: "S256",
    });
  });
});

describe("organic landing query", () => {
  it("filters to Organic Search and the exact days", () => {
    const q = organicLandingQuery("2026-10-01", "2026-10-30");
    expect(q).toContain("$channel_type = 'Organic Search'");
    expect(q).toContain("toDate($start_timestamp) >= toDate('2026-10-01')");
    expect(q).toContain(`LIMIT ${ROW_LIMIT}`);
  });

  it("refuses anything but plain dates, so nothing can be spliced into the SQL", () => {
    expect(() => organicLandingQuery("2026-10-01' OR 1=1 --", "2026-10-02")).toThrow();
  });

  it("maps rows to the shared Analytics shape", () => {
    expect(parseLandingRows([["2026-10-01", "WWW.Example.com", "/a", 5, 3], ["2026-10-01", "example.com", "", "2", null]])).toEqual([
      { date: "2026-10-01", hostName: "www.example.com", landingPage: "/a", sessions: 5, engagedSessions: 3, keyEvents: 0, totalRevenue: 0 },
      { date: "2026-10-01", hostName: "example.com", landingPage: "(not set)", sessions: 2, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 },
    ]);
  });
});

describe("live API", () => {
  it("lists every project across pages when the user granted all of them", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      expect(u.origin).toBe("https://us.posthog.com");
      return u.searchParams.get("offset")
        ? json({ results: [{ id: 3, name: "Blog", timezone: "Europe/London" }], next: null })
        : json({ results: [{ id: 2, name: "Shop" }], next: "https://us.posthog.com/api/projects/?limit=200&offset=200" });
    }) as unknown as typeof fetch;
    expect(await livePosthogApis(7, fetchImpl).projects()).toEqual([
      { id: 2, name: "Shop", timezone: "UTC" },
      { id: 3, name: "Blog", timezone: "Europe/London" },
    ]);
  });

  it("reads only the granted projects when the user picked some", async () => {
    account.scopedTeams = [5];
    const fetchImpl = vi.fn(async () => json({ id: 5, name: "Site", timezone: "UTC" })) as unknown as typeof fetch;
    expect(await livePosthogApis(7, fetchImpl).projects()).toEqual([{ id: 5, name: "Site", timezone: "UTC" }]);
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe("https://us.posthog.com/api/projects/5/");
  });

  it("splits a range whose result hit the row limit", async () => {
    const ranges: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const q: string = JSON.parse(String(init?.body)).query.query;
      const [, start, end] = q.match(/toDate\('([\d-]+)'\) AND toDate\(\$start_timestamp\) <= toDate\('([\d-]+)'\)/)!;
      ranges.push(`${start}..${end}`);
      const full = start === "2026-10-01" && end === "2026-10-04";
      return json({ results: full ? Array.from({ length: ROW_LIMIT }, () => [start, "a.com", "/", 1, 1]) : [[start, "a.com", "/", 1, 0]] });
    }) as unknown as typeof fetch;
    const rows = await livePosthogApis(7, fetchImpl).organicLandingPages(9, "2026-10-01", "2026-10-04");
    expect(ranges).toEqual(["2026-10-01..2026-10-04", "2026-10-01..2026-10-02", "2026-10-03..2026-10-04"]);
    expect(rows).toHaveLength(2);
  });

  it("turns a 429 into a quota error and a 401 into a reconnect", async () => {
    const limited = vi.fn(async () => json({ detail: "slow down" }, 429)) as unknown as typeof fetch;
    await expect(livePosthogApis(7, limited).project(1)).rejects.toBeInstanceOf(PosthogQuotaError);
    const revoked = vi.fn(async () => json({ detail: "bad token" }, 401)) as unknown as typeof fetch;
    await expect(livePosthogApis(7, revoked).project(1)).rejects.toBeInstanceOf(PosthogNotConnectedError);
    expect(reject).toHaveBeenCalledOnce();
  });
});
