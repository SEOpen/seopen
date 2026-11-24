/**
 * Generated Search Console and GA4 data for development (SEOPEN_GOOGLE_FIXTURES=1). It follows
 * the shapes in docs/google.md and is deterministic: the same request always returns the same
 * rows, so the real sync code can run against it and pages can be checked before a Google
 * account is connected. Nothing here is real traffic.
 */
import type { SourceRow } from "@/lib/ai-referrers";
import { expectedCtr } from "./insights";
import { bareDomain } from "./matching";
import type { Ga4LandingRow, GoogleApis, GscQueryRequest, GscRow } from "./types";
import { addDays, eachDay, GSC_TIME_ZONE, todayIn } from "./windowing";

export const FIXTURE_SITES = [
  { siteUrl: "sc-domain:alphanote.example", permissionLevel: "siteOwner" },
  { siteUrl: "https://www.paperfinch.example/", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:fixture-example.com", permissionLevel: "siteFullUser" },
  { siteUrl: "https://unverified-fixture.com/", permissionLevel: "siteUnverifiedUser" },
];

export const FIXTURE_PROPERTIES = [
  { property: "properties/1000001", propertyName: "Alphanote", account: "accounts/100", accountName: "Fixtures", streamDomains: ["www.alphanote.example"] },
  { property: "properties/1000002", propertyName: "PaperFinch site", account: "accounts/100", accountName: "Fixtures", streamDomains: ["paperfinch.example"] },
  { property: "properties/1000003", propertyName: "Fixture example", account: "accounts/100", accountName: "Fixtures", streamDomains: [] },
];

/** Data starts here, so the backfill's earliest-date probe has something to find. */
const FIRST_DATA_DAY = "2025-09-01";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic 0..1 from a string seed. */
function rnd(seed: string): number {
  let t = hash(seed) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const TOPICS = ["shared notes", "daily journal", "macos journal", "markdown notes", "meeting notes", "note templates", "reading list", "voice memos", "focus timer", "menu bar app"];
const MODS = ["", "mac", "free", "best", "for mac", "app", "download", "2026", "how to", "alternative", "offline", "sonoma", "settings", "not working", "vs"];
const SECTIONS = ["", "templates", "blog", "guides", "features", "download", "pricing", "changelog", "compare", "help"];

interface Pair {
  query: string;
  path: string;
  base: number;
  pos: number;
  ctrFactor: number;
  trend: number;
}

const modelCache = new Map<string, Pair[]>();

/** ~150 queries, each ranking for 1–2 pages, with stable base impressions and positions. */
function model(domain: string): Pair[] {
  const cached = modelCache.get(domain);
  if (cached) return cached;
  const label = domain.split(".")[0];
  const pairs: Pair[] = [];
  const pages = SECTIONS.flatMap((s, i) => (s ? [`/${s}/`, `/${s}/${TOPICS[i].replace(/\s+/g, "-")}/`] : ["/"]));
  for (let t = 0; t < TOPICS.length; t++) {
    for (let m = 0; m < MODS.length; m++) {
      const query = [MODS[m] === "how to" ? "how to get" : MODS[m], TOPICS[t], m % 5 === 0 ? label : ""].filter(Boolean).join(" ").trim();
      const seed = `${domain}|${query}`;
      const nPages = rnd(`${seed}|n`) < 0.3 ? 2 : 1;
      for (let k = 0; k < nPages; k++) {
        const path = pages[Math.floor(rnd(`${seed}|p${k}`) * pages.length)];
        const branded = query.includes(label);
        pairs.push({
          query,
          path,
          base: Math.round((branded ? 40 : 4) + rnd(`${seed}|b${k}`) ** 3 * 220),
          pos: branded ? 1 + rnd(`${seed}|r${k}`) * 1.5 : 2 + rnd(`${seed}|r${k}`) * 30,
          // A few rows get a weak snippet, so "low CTR for position" has something to show.
          ctrFactor: rnd(`${seed}|c${k}`) < 0.12 ? 0.3 : 0.8 + rnd(`${seed}|c2${k}`) * 0.4,
          // Some pages slide in the last two months, for "declining pages".
          trend: path.startsWith("/blog/") || path.startsWith("/compare/") ? -1 : rnd(`${seed}|t${k}`) < 0.5 ? 1 : 0,
        });
      }
    }
  }
  modelCache.set(domain, pairs);
  return pairs;
}

function siteOrigin(siteUrl: string): string {
  return siteUrl.startsWith("sc-domain:") ? `https://www.${bareDomain(siteUrl)}` : siteUrl.replace(/\/$/, "");
}

interface DayRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

function dayRows(siteUrl: string, day: string, newest: string): DayRow[] {
  if (day < FIRST_DATA_DAY || day > newest) return [];
  const domain = bareDomain(siteUrl);
  const origin = siteOrigin(siteUrl);
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  const weekday = dow === 0 || dow === 6 ? 0.75 : 1.08;
  const ageDays = (Date.parse(newest) - Date.parse(day)) / 86_400_000;
  const growth = 0.55 + 0.45 * Math.max(0, 1 - ageDays / 420);
  const out: DayRow[] = [];
  for (const p of model(domain)) {
    const recent = ageDays < 60 ? (60 - ageDays) / 60 : 0;
    const trend = p.trend < 0 ? 1 - 0.6 * recent : p.trend > 0 ? 1 + 0.25 * recent : 1;
    const noise = 0.7 + rnd(`${domain}|${p.query}|${p.path}|${day}`) * 0.6;
    const impressions = Math.round(p.base * weekday * growth * trend * noise);
    if (impressions < 1) continue;
    const position = Math.max(1, p.pos + (rnd(`${p.query}|${day}|pos`) - 0.5) * 2 + (p.trend < 0 ? recent * 4 : 0));
    const clicks = Math.round(impressions * expectedCtr(position) * p.ctrFactor);
    out.push({ query: p.query, page: `${origin}${p.path}`, clicks, impressions, position });
  }
  return out;
}

const COUNTRIES: [string, number][] = [["usa", 0.46], ["gbr", 0.11], ["can", 0.08], ["deu", 0.07], ["aus", 0.05], ["fra", 0.04], ["ind", 0.04], ["nld", 0.03], ["jpn", 0.03], ["bra", 0.02]];
const DEVICES: [string, number][] = [["DESKTOP", 0.71], ["MOBILE", 0.26], ["TABLET", 0.03]];

function aggregate(rows: DayRow[], keyOf: (r: DayRow) => string[]): GscRow[] {
  const m = new Map<string, { keys: string[]; clicks: number; impressions: number; posImpr: number }>();
  for (const r of rows) {
    const keys = keyOf(r);
    const k = keys.join("\u0000");
    const a = m.get(k) ?? { keys, clicks: 0, impressions: 0, posImpr: 0 };
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    a.posImpr += r.position * r.impressions;
    m.set(k, a);
  }
  return [...m.values()].map((a) => ({
    keys: a.keys,
    clicks: a.clicks,
    impressions: a.impressions,
    ctr: a.impressions ? a.clicks / a.impressions : 0,
    position: a.impressions ? a.posImpr / a.impressions : 0,
  }));
}

function fixtureQuery(siteUrl: string, req: GscQueryRequest) {
  const today = todayIn(GSC_TIME_ZONE);
  const newestFinal = addDays(today, -3);
  const newest = req.dataState === "all" ? addDays(today, -1) : newestFinal;
  const dims = req.dimensions;
  const rows: GscRow[] = [];
  for (const day of eachDay({ start: req.startDate, end: req.endDate })) {
    const raw = dayRows(siteUrl, day, newest);
    if (!raw.length) continue;
    const key = (r: DayRow, extra?: string) =>
      dims.map((d) => (d === "date" ? day : d === "query" ? r.query : d === "page" ? r.page : (extra ?? "")));
    if (dims.includes("country") || dims.includes("device")) {
      const shares = dims.includes("country") ? COUNTRIES : DEVICES;
      // Anonymized queries are missing from query rows but present in totals: add ~15%.
      const total = aggregate(raw, () => [])[0];
      for (const [k, share] of shares) {
        const f = share * (0.9 + rnd(`${siteUrl}|${day}|${k}`) * 0.2) * 1.15;
        const impressions = Math.round(total.impressions * f);
        const clicks = Math.round(total.clicks * f);
        if (impressions) rows.push({ keys: key(raw[0], k), clicks, impressions, ctr: clicks / impressions, position: total.position * (k === "MOBILE" ? 1.1 : 1) });
      }
    } else if (dims.length === 1) {
      const t = aggregate(raw, () => [day])[0];
      const clicks = Math.round(t.clicks * 1.15);
      const impressions = Math.round(t.impressions * 1.15);
      rows.push({ ...t, clicks, impressions, ctr: clicks / impressions });
    } else {
      rows.push(...aggregate(raw, (r) => key(r)));
    }
  }
  return { rows, firstIncompleteDate: req.dataState === "all" && req.endDate > newestFinal ? addDays(newestFinal, 1) : null };
}

/** Adds up rows with the same keys, as Google does for a request without the date dimension. */
function sumByKeys(rows: GscRow[]): GscRow[] {
  const m = new Map<string, { keys: string[]; clicks: number; impressions: number; posImpr: number }>();
  for (const r of rows) {
    const k = r.keys.join("\u0000");
    const a = m.get(k) ?? { keys: r.keys, clicks: 0, impressions: 0, posImpr: 0 };
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    a.posImpr += r.position * r.impressions;
    m.set(k, a);
  }
  return [...m.values()].map((a) => ({ keys: a.keys, clicks: a.clicks, impressions: a.impressions, ctr: a.impressions ? a.clicks / a.impressions : 0, position: a.impressions ? a.posImpr / a.impressions : 0 }));
}

/**
 * The generated answer with Search Console's filters and row limit applied. A country or device
 * filter on rows not split by it scales each row by that country's or device's share.
 */
function fixtureFiltered(siteUrl: string, req: GscQueryRequest) {
  const dims = req.dimensions;
  const base = fixtureQuery(siteUrl, { ...req, filters: undefined, maxRows: undefined });
  let rows = base.rows;
  for (const f of req.filters ?? []) {
    const want = f.expression.toLowerCase();
    const matches = (v: string) => (f.operator === "equals" ? v.toLowerCase() === want : f.operator === "includingRegex" ? new RegExp(f.expression).test(v) : v.toLowerCase().includes(want));
    const at = dims.indexOf(f.dimension);
    if (at >= 0) {
      rows = rows.filter((r) => matches(r.keys[at] ?? ""));
    } else if (f.dimension === "country" || f.dimension === "device") {
      const share = (f.dimension === "country" ? COUNTRIES : DEVICES).find(([k]) => k.toLowerCase() === want)?.[1] ?? 0;
      rows = rows
        .map((r) => ({ ...r, clicks: Math.round(r.clicks * share), impressions: Math.round(r.impressions * share) }))
        .filter((r) => r.impressions > 0)
        .map((r) => ({ ...r, ctr: r.clicks / r.impressions }));
    }
  }
  if (!dims.includes("date")) rows = sumByKeys(rows).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return { ...base, rows: req.maxRows != null ? rows.slice(0, req.maxRows) : rows };
}

function fixtureLanding(property: string, start: string, end: string): Ga4LandingRow[] {
  const p = FIXTURE_PROPERTIES.find((x) => x.property === property);
  const host = p?.streamDomains[0];
  if (!host) return [];
  const site = FIXTURE_SITES.find((s) => bareDomain(s.siteUrl) === bareDomain(host));
  if (!site) return [];
  const newest = addDays(todayIn(GSC_TIME_ZONE), -1);
  const out: Ga4LandingRow[] = [];
  for (const day of eachDay({ start, end })) {
    const byPage = aggregate(dayRows(site.siteUrl, day, newest), (r) => [r.page]);
    for (const r of byPage) {
      const sessions = Math.round(r.clicks * (0.85 + rnd(`${property}|${day}|${r.keys[0]}`) * 0.4));
      if (!sessions) continue;
      const engaged = Math.round(sessions * (0.45 + rnd(`${r.keys[0]}|eng`) * 0.35));
      const keyEvents = Math.round(engaged * (r.keys[0].includes("/download/") || r.keys[0].includes("/pricing/") ? 0.3 : 0.04));
      out.push({
        date: day,
        hostName: host,
        landingPage: r.keys[0].replace(/^https?:\/\/[^/]+/, ""),
        sessions,
        engagedSessions: engaged,
        keyEvents,
        totalRevenue: r.keys[0].includes("/pricing/") ? keyEvents * 9.99 : 0,
      });
    }
  }
  return out;
}

/** Generated sessions by source: the organic ones under "google", plus a few other sources and AI assistants. */
const FIXTURE_SOURCES: [source: string, share: number][] = [
  ["(direct)", 0.5],
  ["chatgpt.com", 0.06],
  ["perplexity.ai", 0.025],
  ["gemini.google.com", 0.01],
  ["claude.ai", 0.008],
  ["news.ycombinator.com", 0.03],
];

async function fixtureSources(property: string, start: string, end: string): Promise<SourceRow[]> {
  const organic = (await fixtureLanding(property, start, end)).reduce((n, r) => ({ sessions: n.sessions + r.sessions, engaged: n.engaged + r.engagedSessions }), { sessions: 0, engaged: 0 });
  if (!organic.sessions) return [];
  return [
    { sources: ["google"], sessions: organic.sessions, engagedSessions: organic.engaged },
    ...FIXTURE_SOURCES.map(([source, share]) => {
      const sessions = Math.round(organic.sessions * share * (0.8 + rnd(`${property}|${source}`) * 0.4));
      return { sources: [source], sessions, engagedSessions: Math.round(sessions * (0.4 + rnd(`${source}|eng`) * 0.4)) };
    }),
  ].filter((r) => r.sessions > 0);
}

export const fixtureApis: GoogleApis = {
  mode: "fixtures",
  gsc: {
    sites: async () => FIXTURE_SITES,
    query: async (siteUrl, req) => fixtureFiltered(siteUrl, req),
    sitemaps: async (siteUrl) => {
      const origin = siteOrigin(siteUrl);
      return [
        { path: `${origin}/sitemap.xml`, lastSubmitted: "2026-10-20T08:00:00Z", lastDownloaded: "2026-10-27T03:12:00Z", isPending: false, isSitemapsIndex: true, type: "sitemap", errors: 0, warnings: 0, submitted: 34 },
        { path: `${origin}/blog/sitemap.xml`, lastSubmitted: "2026-09-02T08:00:00Z", lastDownloaded: "2026-10-25T11:40:00Z", isPending: false, isSitemapsIndex: false, type: "sitemap", errors: 0, warnings: 1, submitted: 12 },
      ];
    },
    inspect: async (_siteUrl, url) => {
      const indexed = rnd(url) > 0.25;
      return {
        verdict: indexed ? "PASS" : "NEUTRAL",
        coverageState: indexed ? "Submitted and indexed" : "Discovered - currently not indexed",
        indexingState: "INDEXING_ALLOWED",
        robotsTxtState: "ALLOWED",
        pageFetchState: indexed ? "SUCCESSFUL" : "PAGE_FETCH_STATE_UNSPECIFIED",
        lastCrawlTime: indexed ? "2026-10-24T09:31:00Z" : null,
        googleCanonical: indexed ? url : null,
        userCanonical: url,
        crawledAs: indexed ? "MOBILE" : null,
        inspectionResultLink: "https://search.google.com/search-console/inspect",
        richResults: null,
      };
    },
  },
  ga4: {
    properties: async () => FIXTURE_PROPERTIES,
    organicLandingPages: async (property, start, end) => fixtureLanding(property, start, end),
    sourceSessions: async (property, start, end) => fixtureSources(property, start, end),
    timeZone: async () => GSC_TIME_ZONE,
  },
};
