import { fixtureApis as googleFixtures } from "@/modules/google/fixtures";
import { eachDay } from "@/modules/google/windowing";
import { fixtureMode, rejectUmamiCredential, umamiCredential, type UmamiAuthType, type UmamiConnectionInfo } from "./account";
import { hostOf, isSearchReferrer, organicEntryParams, PAGE_ROWS, parseDay, parseSourceRows, SEARCH_REFERRER, SOURCE_PAGES, sourceParams, type ExpandedRow } from "./query";
import { apiRoot, transportFor, type UmamiTransport } from "./server";
import { UmamiAccessError, UmamiHttpError, UmamiNotConnectedError, UmamiQuotaError, UmamiUnreachableError, type UmamiApis, type UmamiLandingRow, type UmamiSite } from "./types";

/**
 * The Umami API client. Endpoints and authentication are from Umami's docs, read 2026-11-11:
 * - https://docs.umami.is/docs/api: Cloud at https://api.umami.is/v1, a self-hosted server at its address plus /api.
 * - https://docs.umami.is/docs/api/authentication: an API key, or POST /api/auth/login with a username and password,
 *   whose `token` goes back as `Authorization: Bearer`. Cloud takes API keys only.
 * - https://docs.umami.is/docs/cloud/api-key: `Authorization: Bearer <api-key>`, 50 calls every 15 seconds per key.
 *   Earlier versions of that page showed an `x-umami-api-key` header, so Cloud requests carry both.
 * - https://docs.umami.is/docs/api-reference/list-websites: GET /websites with page, pageSize and includeTeams,
 *   answering { data, count, page, pageSize }; get-website: GET /websites/:websiteId.
 * - https://docs.umami.is/docs/api-reference/get-website-expanded-metrics: GET /websites/:websiteId/metrics/expanded,
 *   answering [{ name, pageviews, visitors, visits, bounces, totaltime }].
 * - get-website-metrics and get-website-stats, used only by the filter check in `checkUmami`.
 */

/** Fixture websites, each borrowing a GA4 fixture property's generated organic traffic. */
export const FIXTURE_SITES: (UmamiSite & { ga4: string })[] = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Alphanote", domain: "alphanote.example", ga4: "properties/1000001" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Paper Sparrow", domain: "paperfinch.example", ga4: "properties/1000002" },
];

const plain = ({ id, name, domain }: UmamiSite): UmamiSite => ({ id, name, domain });

export const fixtureUmamiApis: UmamiApis = {
  mode: "fixtures",
  sites: async () => FIXTURE_SITES.map(plain),
  site: async (id) => {
    const s = FIXTURE_SITES.find((x) => x.id === id);
    if (!s) throw new Error(`No fixture Umami website ${id}`);
    return plain(s);
  },
  organicLandingPages: async (site, start, end) => {
    const s = FIXTURE_SITES.find((x) => x.id === site.id);
    if (!s) return [];
    const rows = await googleFixtures.ga4.organicLandingPages(s.ga4, start, end);
    return rows.map((r) => ({ ...r, keyEvents: 0, totalRevenue: 0 }));
  },
  sourceSessions: async (siteId, start, end) => {
    const s = FIXTURE_SITES.find((x) => x.id === siteId);
    return s ? googleFixtures.ga4.sourceSessions(s.ga4, start, end) : [];
  },
};

/** Under Umami Cloud's 50 calls every 15 seconds, with room to spare. A sync's requests are spaced this far apart. */
const MIN_GAP_MS = 320;
const SITES_PER_PAGE = 100;
/** A list longer than this many pages is cut off rather than followed for good. */
const MAX_SITE_PAGES = 50;

type SiteJson = { id?: unknown; name?: unknown; domain?: unknown };
const toSite = (j: SiteJson): UmamiSite => ({ id: String(j.id ?? ""), name: String(j.name ?? j.domain ?? ""), domain: String(j.domain ?? "") });

/** An answer that isn't JSON: the address isn't an Umami API (a web page, a proxy's error page). */
class NotUmamiError extends Error {}

export interface UmamiConnection {
  /** Null for Umami Cloud. */
  baseUrl: string | null;
  authType: UmamiAuthType;
  credential: string;
}

/** Umami's own words about a refusal, with the credential taken out in case a response ever repeats it. */
function refusal(status: number, body: string, secret: string): UmamiHttpError {
  let text: string | null = null;
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const e = j?.error;
    text = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : typeof j?.message === "string" ? j.message : null;
  } catch {
    text = null;
  }
  return new UmamiHttpError(status, text ? text.split(secret).join("[credential]").slice(0, 300) : null);
}

/** A client for one connection. Requests are spaced `minGapMs` apart, so a sync stays inside Cloud's rate limit. */
export function umamiClient(c: UmamiConnection, transport: UmamiTransport = transportFor(c.baseUrl), minGapMs = MIN_GAP_MS) {
  const root = apiRoot(c.baseUrl);
  let last = 0;
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${c.credential}`,
    ...(c.baseUrl === null ? { "x-umami-api-key": c.credential } : {}),
  };

  /** The one place the credential leaves SEOpen: to the connection's own API root, and nowhere a redirect might point. */
  async function get<T>(path: string, params?: URLSearchParams): Promise<T> {
    const wait = last + minGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const res = await transport({ url: `${root}${path}${params ? `?${params}` : ""}`, method: "GET", headers });
    if (res.status < 200 || res.status >= 300) throw refusal(res.status, res.body, c.credential);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new NotUmamiError("Not JSON");
    }
  }

  async function sites(): Promise<UmamiSite[]> {
    const out: UmamiSite[] = [];
    for (let page = 1; page <= MAX_SITE_PAGES; page++) {
      const body = await get<{ data?: SiteJson[]; count?: number } | SiteJson[]>("/websites", new URLSearchParams({ page: String(page), pageSize: String(SITES_PER_PAGE), includeTeams: "true" }));
      // Older servers answered with a bare list.
      const data = Array.isArray(body) ? body : (body.data ?? []);
      for (const s of data.map(toSite)) if (s.id && !out.some((o) => o.id === s.id)) out.push(s);
      const count = Array.isArray(body) ? data.length : Number(body.count ?? 0);
      if (Array.isArray(body) || data.length < SITES_PER_PAGE || out.length >= count) break;
    }
    return out;
  }

  async function site(id: string): Promise<UmamiSite> {
    const j = await get<SiteJson | null>(`/websites/${encodeURIComponent(id)}`);
    if (!j?.id) throw new UmamiAccessError();
    return toSite(j);
  }

  async function entries(siteId: string, day: string, engaged: boolean): Promise<ExpandedRow[]> {
    const rows: ExpandedRow[] = [];
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const page = await get<ExpandedRow[]>(`/websites/${encodeURIComponent(siteId)}/metrics/expanded`, organicEntryParams(day, offset, engaged));
      const list = Array.isArray(page) ? page : [];
      rows.push(...list);
      if (list.length < PAGE_ROWS) return rows;
    }
  }

  /** Each day in the range is its own pair of requests: Umami has no daily breakdown of entry pages. */
  async function organicLandingPages(s: UmamiSite, start: string, end: string): Promise<UmamiLandingRow[]> {
    const host = hostOf(s.domain);
    const out: UmamiLandingRow[] = [];
    for (const day of eachDay({ start, end })) out.push(...parseDay(day, host, await entries(s.id, day, false), await entries(s.id, day, true)));
    return out;
  }

  /** A range's visits by referrer domain, largest first, up to SOURCE_PAGES pages. */
  async function sourceSessions(siteId: string, start: string, end: string) {
    const rows: ExpandedRow[] = [];
    for (let page = 0; page < SOURCE_PAGES; page++) {
      const list = await get<ExpandedRow[]>(`/websites/${encodeURIComponent(siteId)}/metrics/expanded`, sourceParams(start, end, page * PAGE_ROWS));
      const got = Array.isArray(list) ? list : [];
      rows.push(...got);
      if (got.length < PAGE_ROWS) break;
    }
    return parseSourceRows(rows);
  }

  /**
   * Whether the server applies SEOpen's search filter. Umami matches nothing on a filter it doesn't
   * understand, which would look like a site with no search visits. So when the last 30 days list a
   * search site as a referrer, the filtered count must find visits.
   */
  async function appliesSearchFilter(siteId: string): Promise<boolean> {
    const endAt = Date.now();
    const startAt = endAt - 30 * 86_400_000;
    const window = { startAt: String(startAt), endAt: String(endAt) };
    const referrers = await get<{ x?: unknown; y?: unknown }[]>(`/websites/${encodeURIComponent(siteId)}/metrics`, new URLSearchParams({ ...window, type: "referrer", limit: "100" }));
    if (!(Array.isArray(referrers) ? referrers : []).some((r) => typeof r.x === "string" && isSearchReferrer(r.x) && Number(r.y) > 0)) return true;
    const stats = await get<{ visits?: unknown }>(`/websites/${encodeURIComponent(siteId)}/stats`, new URLSearchParams({ ...window, referrer: `re.${SEARCH_REFERRER}` }));
    // Older servers wrapped each figure as { value, prev }.
    const v = stats?.visits as { value?: unknown } | number | undefined;
    return Number(typeof v === "object" && v ? v.value : v) > 0;
  }

  return { sites, site, organicLandingPages, sourceSessions, appliesSearchFilter };
}

export type LoginResult = { ok: true; token: string } | { ok: false; error: string };

/**
 * Signs in to a self-hosted server (POST /api/auth/login, https://docs.umami.is/docs/api/authentication)
 * and returns its token. The password goes to that server once and is never stored or logged.
 */
export async function loginUmami(baseUrl: string, username: string, password: string, transport: UmamiTransport = transportFor(baseUrl)): Promise<LoginResult> {
  try {
    const res = await transport({ url: `${apiRoot(baseUrl)}/auth/login`, method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Your Umami server didn't accept that username and password." };
    if (res.status === 429) return { ok: false, error: "Your Umami server is limiting sign-ins. Try again in a few minutes." };
    if (res.status === 404) return { ok: false, error: "There's no Umami sign-in at that address. Check it's the address you open Umami at." };
    if (res.status < 200 || res.status >= 300) return { ok: false, error: "Your Umami server didn't sign SEOpen in. Try again in a minute, or use an API key." };
    const j = JSON.parse(res.body) as { token?: unknown; requiresTwoFactor?: unknown };
    if (j?.requiresTwoFactor) return { ok: false, error: "This Umami user signs in with two-factor authentication. Create an API key in Umami under Settings, API keys, and paste that instead." };
    if (typeof j?.token !== "string" || !j.token) return { ok: false, error: "That address answered, but not as an Umami server." };
    return { ok: true, token: j.token };
  } catch (err) {
    if (err instanceof UmamiUnreachableError) return { ok: false, error: err.message };
    console.error("[umami] login failed:", err instanceof Error ? err.name : "unknown");
    return { ok: false, error: "That address answered, but not as an Umami server." };
  }
}

export type ConnectionCheck = { ok: true; sites: UmamiSite[] } | { ok: false; error: string };

/** Why a credential can't be used, in words for the customer. Umami's own text and the credential stay out of it. */
function connectionProblem(err: unknown, c: UmamiConnection): string {
  if (err instanceof UmamiUnreachableError) return err.message;
  if (err instanceof NotUmamiError) return c.baseUrl ? "That address answered, but not as an Umami server. Check it's the address you open Umami at." : "Umami didn't answer, so nothing is saved. Try again in a minute.";
  const status = err instanceof UmamiHttpError ? err.status : null;
  if (status === 401) return c.authType === "login" ? "Your Umami server signed SEOpen in, then refused the token. Try again, or use an API key." : "Umami didn't accept that API key. Copy it again from Settings, API keys.";
  if (status === 403) return "That Umami user can't read websites through the API.";
  if (status === 404 && c.baseUrl) return "There's no Umami API at that address. Check it's the address you open Umami at.";
  if (status === 429) return "Umami is limiting requests for this key. Try again in a few minutes.";
  return "Umami didn't answer, so nothing is saved. Try again in a minute.";
}

/**
 * Checks a credential with real requests before anything is stored: it lists the websites, then
 * checks the server applies the search filter on the first, so a server too old for it is caught
 * here instead of syncing no visits.
 */
export async function checkUmami(c: UmamiConnection, transport?: UmamiTransport, minGapMs?: number): Promise<ConnectionCheck> {
  const client = umamiClient(c, transport, minGapMs);
  try {
    const sites = await client.sites();
    if (sites[0] && !(await client.appliesSearchFilter(sites[0].id))) {
      return { ok: false, error: "This Umami server didn't apply SEOpen's search filter, so it would show no visits from search. Update Umami to version 3 or later, then connect it again." };
    }
    return { ok: true, sites };
  } catch (err) {
    // The status or the error's name, and nothing Umami said, so the logs can't pick up a pasted credential.
    console.error("[umami] connection check failed:", err instanceof UmamiHttpError ? err.status : err instanceof Error ? err.name : "unknown");
    return { ok: false, error: connectionProblem(err, c) };
  }
}

/** The client for one stored connection. `transport` is for tests. */
export function liveUmamiApis(workspaceId: number, transport?: UmamiTransport, minGapMs?: number): UmamiApis {
  let client: { c: ReturnType<typeof umamiClient>; account: UmamiConnectionInfo } | null = null;
  async function connected() {
    if (!client) {
      const { credential, account } = await umamiCredential(workspaceId);
      client = { c: umamiClient({ baseUrl: account.baseUrl, authType: account.authType as UmamiAuthType, credential }, transport, minGapMs), account };
    }
    return client;
  }

  async function run<T>(op: (c: ReturnType<typeof umamiClient>) => Promise<T>): Promise<T> {
    const { c, account } = await connected();
    try {
      return await op(c);
    } catch (err) {
      if (err instanceof UmamiHttpError) return fail(err, c, account);
      throw err;
    }
  }

  async function fail(err: UmamiHttpError, c: ReturnType<typeof umamiClient>, account: UmamiConnectionInfo): Promise<never> {
    if (err.status === 401) {
      // Umami says 401 for a bad credential and for a website it can't read. The website list tells which.
      const refused = await c.sites().then(
        () => false,
        (e: unknown) => e instanceof UmamiHttpError && e.status === 401,
      );
      if (!refused) throw new UmamiAccessError();
      await rejectUmamiCredential(account);
      throw new UmamiNotConnectedError("reauth_required");
    }
    if (err.status === 403 || err.status === 404) throw new UmamiAccessError();
    if (err.status === 429) throw new UmamiQuotaError(err.detail ?? "Umami rate limit reached");
    throw err;
  }

  return {
    mode: "live",
    sites: () => run((c) => c.sites()),
    site: (id) => run((c) => c.site(id)),
    organicLandingPages: (s, start, end) => run((c) => c.organicLandingPages(s, start, end)),
    sourceSessions: (s, start, end) => run((c) => c.sourceSessions(s, start, end)),
  };
}

/** The Umami client for the workspace's connection. Throws UmamiNotConnectedError when there is none. */
export function umamiApis(workspaceId: number): UmamiApis {
  return fixtureMode() ? fixtureUmamiApis : liveUmamiApis(workspaceId);
}
