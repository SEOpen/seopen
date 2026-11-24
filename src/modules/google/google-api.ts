import { analyticsadmin } from "@googleapis/analyticsadmin";
import { analyticsdata, type analyticsdata_v1beta } from "@googleapis/analyticsdata";
import { searchconsole } from "@googleapis/searchconsole";
import type { OAuth2Client } from "google-auth-library";
import { classifyGoogleError } from "./auth";
import { bareDomain } from "./matching";
import { GoogleQuotaError, type Ga4LandingRow, type Ga4Property, type GoogleApis, type GscRow } from "./types";

const GSC_PAGE = 25_000;
const GA4_PAGE = 100_000;
/** Sources one AI assistants request reads, the largest first. */
const SOURCE_ROWS = 10_000;
/** Standard (non-360) property limit for core reporting tokens per project per hour. */
const GA4_TOKENS_PER_PROJECT_HOUR = 14_000;

/** The live Search Console and GA4 clients, sharing one OAuth2Client. */
export function liveApis(auth: OAuth2Client, accountId: number): GoogleApis {
  const sc = searchconsole({ version: "v1", auth });
  const admin = analyticsadmin({ version: "v1beta", auth });
  const data = analyticsdata({ version: "v1beta", auth });
  const guard = <T>(p: Promise<T>) => p.catch((err) => classifyGoogleError(err, accountId));

  return {
    mode: "live",
    gsc: {
      async sites() {
        const { data: d } = await guard(sc.sites.list());
        return (d.siteEntry ?? []).map((s) => ({ siteUrl: s.siteUrl ?? "", permissionLevel: s.permissionLevel ?? "" })).filter((s) => s.siteUrl);
      },

      async query(siteUrl, req) {
        const rows: GscRow[] = [];
        let firstIncompleteDate: string | null = null;
        for (let startRow = 0; ; startRow += GSC_PAGE) {
          const res = await guard(
            sc.searchanalytics.query({
              siteUrl,
              requestBody: {
                startDate: req.startDate,
                endDate: req.endDate,
                dimensions: req.dimensions,
                type: "web",
                dataState: req.dataState ?? "final",
                // Page grouping needs byPage; everything else is exact per property.
                aggregationType: req.dimensions.includes("page") ? "byPage" : "auto",
                ...(req.filters?.length ? { dimensionFilterGroups: [{ groupType: "and", filters: req.filters }] } : {}),
                rowLimit: GSC_PAGE,
                startRow,
              },
            }),
          );
          firstIncompleteDate ??= res.data.metadata?.firstIncompleteDate ?? null;
          const batch = res.data.rows ?? [];
          for (const r of batch) {
            rows.push({ keys: r.keys ?? [], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: r.ctr ?? 0, position: r.position ?? 0 });
          }
          if (batch.length < GSC_PAGE || (req.maxRows != null && rows.length >= req.maxRows)) break;
        }
        return { rows: req.maxRows != null ? rows.slice(0, req.maxRows) : rows, firstIncompleteDate };
      },

      async sitemaps(siteUrl) {
        const { data: d } = await guard(sc.sitemaps.list({ siteUrl }));
        return (d.sitemap ?? []).map((m) => ({
          path: m.path ?? "",
          lastSubmitted: m.lastSubmitted ?? null,
          lastDownloaded: m.lastDownloaded ?? null,
          isPending: !!m.isPending,
          isSitemapsIndex: !!m.isSitemapsIndex,
          type: m.type ?? null,
          errors: Number(m.errors ?? 0),
          warnings: Number(m.warnings ?? 0),
          submitted: (m.contents ?? []).reduce((n, c) => n + Number(c.submitted ?? 0), 0),
        }));
      },

      async inspect(siteUrl, url) {
        const { data: d } = await guard(sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: url, siteUrl, languageCode: "en-US" } }));
        const r = d.inspectionResult ?? {};
        const s = r.indexStatusResult ?? {};
        return {
          verdict: s.verdict ?? null,
          coverageState: s.coverageState ?? null,
          indexingState: s.indexingState ?? null,
          robotsTxtState: s.robotsTxtState ?? null,
          pageFetchState: s.pageFetchState ?? null,
          lastCrawlTime: s.lastCrawlTime ?? null,
          googleCanonical: s.googleCanonical ?? null,
          userCanonical: s.userCanonical ?? null,
          crawledAs: s.crawledAs ?? null,
          inspectionResultLink: r.inspectionResultLink ?? null,
          richResults: r.richResultsResult ?? null,
        };
      },
    },

    ga4: {
      async properties() {
        const out: Ga4Property[] = [];
        let pageToken: string | undefined;
        do {
          const { data: d } = await guard(admin.accountSummaries.list({ pageSize: 200, pageToken }));
          for (const a of d.accountSummaries ?? []) {
            for (const p of a.propertySummaries ?? []) {
              out.push({ property: p.property ?? "", propertyName: p.displayName ?? "", account: a.account ?? "", accountName: a.displayName ?? "", streamDomains: [] });
            }
          }
          pageToken = d.nextPageToken ?? undefined;
        } while (pageToken);
        // Web stream hostnames make matching reliable; a property without access just keeps [].
        await Promise.all(
          out.map(async (p) => {
            try {
              const { data: d } = await admin.properties.dataStreams.list({ parent: p.property, pageSize: 50 });
              p.streamDomains = (d.dataStreams ?? []).map((s) => s.webStreamData?.defaultUri).filter((u): u is string => !!u).map(bareDomain);
            } catch {
              // ignore
            }
          }),
        );
        return out.filter((p) => p.property);
      },

      async timeZone(property) {
        const { data: d } = await guard(admin.properties.get({ name: property }));
        return d.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      },

      async organicLandingPages(property, start, end) {
        const requestBody: analyticsdata_v1beta.Schema$RunReportRequest = {
          dateRanges: [{ startDate: start, endDate: end }],
          dimensions: [{ name: "date" }, { name: "hostName" }, { name: "landingPage" }],
          metrics: [{ name: "sessions" }, { name: "engagedSessions" }, { name: "keyEvents" }, { name: "totalRevenue" }],
          dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } },
          // Order by every dimension: with ties, offset paging can repeat or skip rows.
          orderBys: ["date", "hostName", "landingPage"].map((dimensionName) => ({ dimension: { dimensionName } })),
          limit: String(GA4_PAGE),
          keepEmptyRows: false,
          returnPropertyQuota: true,
        };
        const rows: Ga4LandingRow[] = [];
        for (let offset = 0; ; offset += GA4_PAGE) {
          const res = await guard(data.properties.runReport({ property, requestBody: { ...requestBody, offset: String(offset) } }));
          for (const r of res.data.rows ?? []) {
            const [d, host, page] = (r.dimensionValues ?? []).map((v) => v.value ?? "");
            const [sessions, engaged, keyEvents, revenue] = (r.metricValues ?? []).map((v) => Number(v.value ?? 0));
            rows.push({
              date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
              hostName: host,
              landingPage: page,
              sessions,
              engagedSessions: engaged,
              keyEvents,
              totalRevenue: revenue,
            });
          }
          // `consumed` is this request's cost, so compare against the hourly limit, not remaining + consumed.
          const left = res.data.propertyQuota?.tokensPerProjectPerHour?.remaining;
          if (left != null && left < GA4_TOKENS_PER_PROJECT_HOUR * 0.2) {
            throw new GoogleQuotaError(`GA4 ${property}: only ${left} of ${GA4_TOKENS_PER_PROJECT_HOUR} project tokens left this hour`);
          }
          if (offset + GA4_PAGE >= (res.data.rowCount ?? 0)) break;
        }
        return rows;
      },

      async sourceSessions(property, start, end) {
        // One request: a site with more sources than this has its smallest ones cut, which an AI assistant with visits is unlikely to be.
        const res = await guard(
          data.properties.runReport({
            property,
            requestBody: {
              dateRanges: [{ startDate: start, endDate: end }],
              dimensions: [{ name: "sessionSource" }],
              metrics: [{ name: "sessions" }, { name: "engagedSessions" }],
              orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
              limit: String(SOURCE_ROWS),
              keepEmptyRows: false,
            },
          }),
        );
        return (res.data.rows ?? []).map((r) => {
          const [sessions, engaged] = (r.metricValues ?? []).map((v) => Number(v.value ?? 0));
          return { sources: [r.dimensionValues?.[0]?.value ?? null], sessions, engagedSessions: engaged };
        });
      },
    },
  };
}
