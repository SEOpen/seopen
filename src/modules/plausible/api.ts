import { fixtureApis as googleFixtures } from "@/modules/google/fixtures";
import { fixtureMode, plausibleKey, rejectPlausibleKey, type PlausibleConnectionInfo } from "./account";
import { organicLandingQuery, PAGE_ROWS, parseLandingRows, parseSourceRows, sourceSessionsQuery, type QueryRow } from "./query";
import { PLAUSIBLE_ORIGIN, PlausibleAccessError, PlausibleHttpError, PlausibleNotConnectedError, PlausibleQuotaError, type PlausibleApis, type PlausibleLandingRow, type PlausibleSite } from "./types";

/** Fixture sites, each borrowing a GA4 fixture property's generated organic traffic. */
export const FIXTURE_SITES: (PlausibleSite & { ga4: string })[] = [
  { domain: "alphanote.example", timezone: "America/New_York", ga4: "properties/1000001" },
  { domain: "paperfinch.example", timezone: "America/New_York", ga4: "properties/1000002" },
];

export const fixturePlausibleApis: PlausibleApis = {
  mode: "fixtures",
  sites: async () => FIXTURE_SITES.map(({ domain, timezone }) => ({ domain, timezone })),
  site: async (id) => {
    const s = FIXTURE_SITES.find((x) => x.domain === id);
    if (!s) throw new Error(`No fixture Plausible site ${id}`);
    return { domain: s.domain, timezone: s.timezone };
  },
  organicLandingPages: async (id, start, end) => {
    const s = FIXTURE_SITES.find((x) => x.domain === id);
    if (!s) return [];
    const rows = await googleFixtures.ga4.organicLandingPages(s.ga4, start, end);
    return rows.map((r) => ({ ...r, keyEvents: 0, totalRevenue: 0 }));
  },
  sourceSessions: async (id, start, end) => {
    const s = FIXTURE_SITES.find((x) => x.domain === id);
    return s ? googleFixtures.ga4.sourceSessions(s.ga4, start, end) : [];
  },
};

/** Long enough for a real query, and short enough that a stuck one can't hold up the Analytics page. */
const TIMEOUT_MS = 30_000;
const SITES_PER_PAGE = 100;

type SiteJson = { domain?: string; timezone?: string };
type SitesPage = { sites?: SiteJson[]; meta?: { after?: string | null } };

const toSite = (j: SiteJson): PlausibleSite => ({ domain: String(j.domain ?? ""), timezone: j.timezone || "UTC" });

/** Plausible's own words about a refusal, with the key taken out in case a response ever repeats it. */
async function refusal(res: Response, key: string): Promise<PlausibleHttpError> {
  const error = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
  return new PlausibleHttpError(res.status, typeof error === "string" ? error.split(key).join("[key]") : null);
}

/** The one place the key leaves SEOpen: as a bearer token, to Plausible Cloud and nowhere a redirect might point. */
async function request<T>(key: string, path: string, fetchImpl: typeof fetch, body?: unknown): Promise<T> {
  const res = await fetchImpl(new URL(path, PLAUSIBLE_ORIGIN), {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.ok) return (await res.json()) as T;
  throw await refusal(res, key);
}

/** Every site the key's team owns, following Plausible's cursor. Works with a Stats API key. */
async function listSites(key: string, fetchImpl: typeof fetch): Promise<PlausibleSite[]> {
  const out: PlausibleSite[] = [];
  let after: string | null | undefined = null;
  do {
    const query: string = `/api/v1/sites?limit=${SITES_PER_PAGE}${after ? `&after=${encodeURIComponent(after)}` : ""}`;
    const page: SitesPage = await request(key, query, fetchImpl);
    out.push(...(page.sites ?? []).map(toSite).filter((s) => s.domain));
    after = page.meta?.after;
  } while (after);
  return out;
}

export type KeyCheck = { ok: true; sites: PlausibleSite[] } | { ok: false; error: string };

/** Why a pasted key can't be used, in words for the customer. Plausible's own text and the key stay out of it. */
function keyProblem(err: unknown): string {
  const status = err instanceof PlausibleHttpError ? err.status : null;
  if (status === 401) return "Plausible didn't accept that key. Copy it again, and check it's a Stats API key.";
  if (status === 402) return "Plausible says this account doesn't include the Stats API. It's on Plausible's Business plan, and the account's subscription has to be active.";
  if (status === 429) return "Plausible is limiting requests for this key. Try again in a few minutes.";
  return "Plausible didn't answer, so the key isn't saved. Try again in a minute.";
}

/**
 * Checks a pasted key with real requests before anything is stored: it lists the team's sites, then
 * runs a one-day query on the first, because the listing alone doesn't prove the Stats API is open to it.
 */
export async function checkPlausibleKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  try {
    const sites = await listSites(key, fetchImpl);
    if (sites[0]) await request(key, "/api/v2/query", fetchImpl, { site_id: sites[0].domain, metrics: ["visits"], date_range: "day" });
    return { ok: true, sites };
  } catch (err) {
    // The status or the error's name, and nothing Plausible said, so the logs can't pick up a pasted key.
    console.error("[plausible] key check failed:", err instanceof PlausibleHttpError ? err.status : err instanceof Error ? err.name : "unknown");
    return { ok: false, error: keyProblem(err) };
  }
}

/** The client for one stored connection. `fetchImpl` is for tests. */
export function livePlausibleApis(workspaceId: number, fetchImpl: typeof fetch = fetch): PlausibleApis {
  async function withKey<T>(run: (key: string) => Promise<T>): Promise<T> {
    const { key, account } = await plausibleKey(workspaceId);
    try {
      return await run(key);
    } catch (err) {
      if (err instanceof PlausibleHttpError) return fail(err, key, account);
      throw err;
    }
  }

  async function fail(err: PlausibleHttpError, key: string, account: PlausibleConnectionInfo): Promise<never> {
    if (err.status === 401) {
      // Plausible says 401 for a bad key and for a site the key can't read. The site list tells which.
      const refused = await listSites(key, fetchImpl).then(
        () => false,
        (e: unknown) => e instanceof PlausibleHttpError && e.status === 401,
      );
      if (!refused) throw new PlausibleAccessError("site");
      await rejectPlausibleKey(account);
      throw new PlausibleNotConnectedError("reauth_required");
    }
    if (err.status === 402) {
      console.error("[plausible] 402:", err.detail ?? "no detail");
      throw new PlausibleAccessError("plan");
    }
    if (err.status === 429) throw new PlausibleQuotaError(err.detail ?? "Plausible rate limit reached");
    throw err;
  }

  return {
    mode: "live",
    sites: () => withKey((key) => listSites(key, fetchImpl)),
    site: async (id) => toSite(await withKey((key) => request<SiteJson>(key, `/api/v1/sites/${encodeURIComponent(id)}`, fetchImpl))),
    organicLandingPages: (siteId, start, end) =>
      withKey(async (key) => {
        const rows: QueryRow[] = [];
        for (let offset = 0; ; offset += PAGE_ROWS) {
          const { results = [] } = await request<{ results?: QueryRow[] }>(key, "/api/v2/query", fetchImpl, organicLandingQuery(siteId, start, end, offset));
          rows.push(...results);
          if (results.length < PAGE_ROWS) return parseLandingRows(rows) satisfies PlausibleLandingRow[];
        }
      }),
    sourceSessions: (siteId, start, end) =>
      withKey(async (key) => {
        const { results = [] } = await request<{ results?: QueryRow[] }>(key, "/api/v2/query", fetchImpl, sourceSessionsQuery(siteId, start, end));
        return parseSourceRows(results);
      }),
  };
}

/** The Plausible client for the workspace's connection. Throws PlausibleNotConnectedError when there is none. */
export function plausibleApis(workspaceId: number): PlausibleApis {
  return fixtureMode() ? fixturePlausibleApis : livePlausibleApis(workspaceId);
}
