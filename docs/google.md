# Google APIs for SEOPen (Search Console + GA4)

Researched 2026-10-29 against current Google docs (sources at the end). Scope: the Google Cloud project and OAuth client a SEOpen install needs, the console steps, and the Search Console and GA4 APIs the `google` module uses.

**What you need:**
- A Google Cloud project of your own with the Search Console API, the Analytics Data API and the Analytics Admin API enabled.
- A Web OAuth client, with its ID and secret in `.env.local` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`).
- For the Local SEO map, optionally, the Maps Static API in the same project. It needs billing on the project, an API key limited to that API (`GOOGLE_MAPS_STATIC_KEY`) and a URL signing secret (`GOOGLE_MAPS_SIGNING_SECRET`). Without them the map is off.
- **Adding sites:** on `/gsc`, map existing projects in the Properties table. Use **Import from Search Console** to tick which unmapped sites become projects, each with a GA4 property (suggested by domain where one matches).

---

## 1. Recommendation

| Decision | Choice | Why |
|---|---|---|
| User type | **External** | A personal Google account has no Workspace organization, so Internal can't be selected. If every user is in your own Workspace organization, Internal avoids verification. |
| Publishing status | **In production.** Verify the app if more than a handful of people outside your organization will connect. | In **Testing**, refresh tokens for these scopes **expire 7 days** after consent. **In production**, the 7-day expiry doesn't apply. Until the app is verified, Google shows the unverified-app warning and at most 100 users can grant the scopes. A change to scopes or the consent screen needs a new verification request. |
| Client type | **Web application** | The redirect URI `http://127.0.0.1:4100/api/google/callback` is allowed. Localhost IPs are exempt from both the HTTPS rule and the no-raw-IP rule. The token exchange happens server-side in a Next.js route handler, with the client secret kept in `.env.local`. Use PKCE as well. |
| Scopes | `openid`, `email`, `https://www.googleapis.com/auth/webmasters.readonly`, `https://www.googleapis.com/auth/analytics.readonly`. Google sign-in asks for `openid`, `email` and `profile`, and Data Access lists all five. | Google data goes to no other service, including DataForSEO, and a test keeps guided setup from reading it (`src/modules/setup/propose.test.ts`). Google verification wants the narrowest scope, so SEOPen doesn't submit sitemaps (which needs the full `webmasters` scope) and links to Search Console instead. A connection holding the full scope still counts as covering read-only. `analytics.readonly` covers both the Data API and the Admin API's `accountSummaries.list`. `openid email` only identifies which Google account is connected. On the Data Access page, `analytics.readonly` is listed as sensitive and `webmasters.readonly` as non-sensitive. |
| Libraries | `google-auth-library@^11.3` for OAuth, plus the per-API REST clients `@googleapis/searchconsole@^11`, `@googleapis/analyticsdata@^10` and `@googleapis/analyticsadmin@^22` | The `googleapis` mega-package unpacks to **246 MB**; these four together are about 5 MB and share one `OAuth2Client`. All need Node 22 or later. Avoid the gRPC clients (`@google-analytics/data` and `/admin`). |
| Token storage | AES-256-GCM in Postgres, with the key in `.env.local` (`SEOPEN_SECRET_KEY`, 32 random bytes, base64) | See section 5. |

### Token-expiry facts (verified)
- **Testing plus External:** Test users' authorizations and offline refresh tokens **expire 7 days after consent**. The only exemption is an app that requests nothing beyond `openid`, `userinfo.email` and `userinfo.profile`. Testing also caps the app at 100 test users and shows the unverified warning.
- **In production, unverified:** Refresh tokens follow normal rules and don't expire on a schedule. The unverified-app screen appears ("Google hasn't verified this app"; click **Advanced**, then **Go to <app name> (unsafe)**). The user cap is **100 new users over the project's lifetime**; it can't be reset, and you raise it only by passing verification. A personal install never gets close.
- **What still kills a production refresh token:** the user revokes access (myaccount.google.com/permissions or `oauth2.googleapis.com/revoke`); the token goes **unused for 6 months** (the daily sync prevents this); more than **100 refresh tokens per Google account per client ID**, at which point the oldest is invalidated silently, so don't re-consent in a loop; or the user picked **time-based access** at consent, in which case the response includes `refresh_token_expires_in`. Treat that field as a warning.
- **OAuth client cleanup:** A client that's inactive for 6 months is auto-deleted (Google emails you 30 days ahead). Daily syncs count as activity.
- **Re-consent after publishing:** If you connect while still in Testing, connect again after publishing. Tokens issued under Testing keep their 7-day expiry.

### Sensitive or restricted?
- **Neither scope is restricted.** Google's restricted list covers Gmail, Drive and similar data, not Search Console or Analytics.
- **`analytics.readonly`:** **sensitive** (it reads user data). Google's public scope list carries no sensitivity marker; the authoritative label is on the **Data Access** page.
- **`webmasters.readonly`:** non-sensitive on the Data Access page.
- **For a personal install** the result is the same either way: publish, skip verification, and click through the warning once.

### Desktop app vs Web application
- **Desktop app:** A public client. You register no redirect URI, and Google accepts any loopback `http://127.0.0.1:<port>` redirect. PKCE is required in practice, and the secret is "not secret". It works, but it's the pattern for CLIs that open a random port.
- **Web application:** A confidential client with an exact registered redirect. This matches a fixed-port Next.js app. Changes to redirect URIs **can take 5 minutes to a few hours** to take effect.
- **Pick Web application.**

---

## 2. Console checklist

Notes:
- Every URL takes `?project=<PROJECT_ID>`.
- The console UI is the "Google Auth Platform" (left nav: Overview, Branding, Audience, Clients, Data Access, Verification Center, Settings).
- Read the Google API Services: User Data Policy before you agree to it.

### Step 1: Create the project
- URL: https://console.cloud.google.com/projectcreate
- **Project name:** anything, for example `SEOpen`.
- **Project ID:** Accept the generated ID. **Record it.**
- **Location / Organization:** "No organization", or your own.
- Click **Create**. Wait for the notification, then select the project in the project picker.
- Billing isn't needed for these APIs. (The Maps Static API does need it.)

### Step 2: Enable the APIs (each page has one **Enable** button)
1. Google Search Console API: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com?project=PROJECT_ID
2. Google Analytics Data API: https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com?project=PROJECT_ID
3. Google Analytics Admin API: https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com?project=PROJECT_ID

Verify all three are listed at https://console.cloud.google.com/apis/dashboard?project=PROJECT_ID.

### Step 3: Configure the Google Auth Platform (the consent screen)
- URL: https://console.cloud.google.com/auth/overview?project=PROJECT_ID. If it says "Google Auth platform not configured yet", click **Get started**. Also reachable from https://console.cloud.google.com/auth/branding.
- Wizard:
  1. **App Information:** App name (what users see on the consent screen). User support email: your own address (dropdown). **Next**.
  2. **Audience:** **External** (or Internal, if every user is in your Workspace organization). **Next**.
  3. **Contact Information:** your own address. **Next**.
  4. **Finish:** Tick "I agree to the Google API Services: User Data Policy". **Continue**, then **Create**.

### Step 4: Branding (review only)
- URL: https://console.cloud.google.com/auth/branding?project=PROJECT_ID
- **Leave App logo empty.** A logo triggers brand verification.
- App domain: your home page and privacy policy URLs (the privacy page must be public, with no sign-in), terms optional. Authorized domains: your domain, which also covers its subdomains, such as an `app.` host. Publishing and verification need the first two; a localhost-only setup can leave them empty.
- Developer contact information: your own address. **Save** if anything changed.

### Step 5: Data Access (declare scopes)
- URL: https://console.cloud.google.com/auth/scopes?project=PROJECT_ID
1. Click **Add or remove scopes**.
2. Filter and tick these, or paste them into "Manually add scopes", then click **Add to table**:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/webmasters.readonly`
   - `https://www.googleapis.com/auth/analytics.readonly`
3. Click **Update**, then **Save**.

### Step 6: Audience (test user and publishing status)
- URL: https://console.cloud.google.com/auth/audience?project=PROJECT_ID
1. **Test users:** Click **+ Add users**, enter the Google account you'll connect, **Save**. This is harmless in production and useful if you ever flip back to Testing.
2. **Publishing status:** Click **Publish app**, then confirm "Push to production?". Because `analytics.readonly` is sensitive, the dialog may say verification is needed. For a personal install, confirm anyway and skip verification. To offer the app to other people, start verification in the Verification Center (it asks for a demo video of the consent flow and how the data is used).
3. Expected result: "Publishing status: In production". User type: External.

### Step 7: Create the OAuth client
- URL: https://console.cloud.google.com/auth/clients/create?project=PROJECT_ID (or Clients, then **+ Create client**)
- **Application type:** Web application
- **Name:** anything, for example `SEOpen local`.
- **Authorized JavaScript origins:** Leave empty. `http://127.0.0.1:4100` is OK if you want one.
- **Authorized redirect URIs:** **+ Add URI**, then `http://127.0.0.1:4100/api/google/callback`. It must match exactly: no trailing slash, `127.0.0.1` not `localhost`.
  - A deployed install also needs `https://<your app host>/api/google/callback` here, and your domain under Branding → Authorized domains.
- **"Use this client for an AI-powered agent":** Leave unticked; it can't be changed later.
- Click **Create**.
- **The client secret is shown in full only once, at creation.** After that the console shows only the last 4 characters. Click **Download JSON**, or copy the Client ID and Client secret immediately.
- **Don't paste the secret into chat or a commit.** Write it straight into `.env.local`:
  ```
  GOOGLE_CLIENT_ID=....apps.googleusercontent.com
  GOOGLE_CLIENT_SECRET=GOCSPX-...
  GOOGLE_REDIRECT_URI=http://127.0.0.1:4100/api/google/callback
  SEOPEN_SECRET_KEY=<openssl rand -base64 32>
  ```
- Wait at least 5 minutes before the first connect attempt. Redirect changes can take up to a few hours to propagate; a `redirect_uri_mismatch` error right after creation is usually propagation delay.

### Step 8: Optional checks
- Quotas: https://console.cloud.google.com/apis/api/searchconsole.googleapis.com/quotas?project=PROJECT_ID and the same path for `analyticsdata.googleapis.com`.
- Clients list: https://console.cloud.google.com/auth/clients?project=PROJECT_ID

### First connect (in SEOpen)
1. SEOpen redirects to Google.
2. Choose the account. You'll see "Google hasn't verified this app" on an unverified app; click **Advanced**, then **Go to <app name> (unsafe)**.
3. On the granular consent screen, **tick every checkbox** (Search Console and Analytics).
4. Click **Continue**.
5. SEOpen checks the granted `scope` string and shows what's missing.

---

## 3. Search Console API

The REST host is `https://www.googleapis.com/webmasters/v3/...` (search analytics, sites, sitemaps) and `https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`. The `@googleapis/searchconsole` client (`searchconsole_v1`) covers all four resources.

- **`siteUrl` formats:** a URL-prefix property with a trailing slash (`https://www.example.com/`), or a Domain property (`sc-domain:example.com`). URL-encode it in paths; the client library does this for you.

### Quotas (developers.google.com/webmaster-tools/limits)
| Resource | Per site | Per user | Per project |
|---|---|---|---|
| searchanalytics.query | 1,200 QPM | 1,200 QPM | 40,000 QPM; 30,000,000 QPD |
| searchanalytics **load** quota | Short-term (10-minute buckets) and long-term (1-day buckets) | | |
| urlInspection.index.inspect | **2,000 QPD; 600 QPM** | | 15,000 QPM; 10,000,000 QPD |
| sites, sitemaps (all other) | | 20 QPS; 200 QPM | 100,000,000 QPD |

- **Load is the real limit.** Grouping or filtering by `page` and `query` together is the most expensive, and cost grows with date range.
- **Every quota failure returns the same "quota exceeded" error.** Back off 15 minutes. If it persists, you've hit the daily load quota, so stop until tomorrow.
- **Keep requests to one day each** (`startDate == endDate`).

### searchanalytics.query (`POST /sites/{siteUrl}/searchAnalytics/query`)
- **`startDate`, `endDate`:** `YYYY-MM-DD` in **Pacific Time**, inclusive.
- **`dimensions`:** `date`, `hour`, `query`, `page`, `country` (ISO-3166 alpha-3), `device` (`DESKTOP`, `MOBILE`, `TABLET`), `searchAppearance`. Each dimension may appear only once.
- **`type`:**
  - `web` is the default and means the "All" tab, excluding Discover and News.
  - The others are `image`, `video`, `news` (the Search News tab), `discover` and `googleNews` (news.google.com and the News app).
  - Discover and Google News have no query data.
- **`dimensionFilterGroups`:**
  - `groupType` supports only `and`.
  - Operators: `equals` (the default), `notEquals`, `contains`, `notContains`, `includingRegex`, `excludingRegex` (RE2).
  - `equals` and `notEquals` are case-sensitive for page and query.
- **`aggregationType`:**
  - `auto` is the default. The others are `byPage`, `byProperty` and `byNewsShowcasePanel`.
  - Grouping or filtering by page rules out `byProperty`.
  - `byProperty` isn't supported for `discover` or `googleNews`.
- **`rowLimit`:** 1 to **25,000** (default 1,000).
- **`startRow`:** Zero-based offset. Page by +25,000 until a response has 0 rows.
- **The API exposes at most 50,000 rows per day per search type**, sorted by clicks. That means 2 pages per day per type at most.
- **`dataState`:**
  - `final` is the default: finalized data only.
  - `all` adds fresh, preliminary data.
  - `hourly_all` adds partial hourly data; use it with the `hour` dimension.
- **Response:**
  - `rows[]` holds `{ keys[], clicks, impressions, ctr (0–1), position }`.
  - `responseAggregationType`.
  - `metadata.first_incomplete_date` appears only with `all` grouped by `date`; `metadata.first_incomplete_hour` only with `hourly_all` grouped by `hour`. Times are America/Los_Angeles, and values on or after these may still change.
- **Freshness:** Final data typically lands **2–3 days** after the date. Fresh data (`all`) covers the latest day or so and is marked preliminary in the UI.
- **History:** **16 months.** Older dates return nothing, which is why SEOPen keeps its own copy.
- **Accuracy:** For exact totals, omit `page` and `query`. Adding them drops some data (anonymized queries and row truncation), and page grouping changes how clicks, impressions, CTR and position are aggregated. So **store totals separately** and never sum query rows to get site totals.

```ts
import { searchconsole, searchconsole_v1 } from '@googleapis/searchconsole';
import type { OAuth2Client } from 'google-auth-library';

export type GscType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';

/** One day, one type, one dimension set. Pages through all rows (max 50k/day/type). */
export async function fetchGscDay(
  auth: OAuth2Client,
  siteUrl: string,            // 'sc-domain:example.com' or 'https://www.example.com/'
  day: string,                // 'YYYY-MM-DD' (PT)
  dimensions: string[],       // e.g. ['date','query','page']
  type: GscType = 'web',
  dataState: 'final' | 'all' = 'final',
) {
  const sc = searchconsole({ version: 'v1', auth });
  const rows: searchconsole_v1.Schema$ApiDataRow[] = [];
  for (let startRow = 0; ; startRow += 25_000) {
    const res = await sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: day,
        endDate: day,
        dimensions,
        type,
        dataState,
        aggregationType: dimensions.includes('page') ? 'byPage' : 'auto',
        rowLimit: 25_000,
        startRow,
      },
    });
    const batch = res.data.rows ?? [];
    rows.push(...batch);
    if (batch.length < 25_000) break;
  }
  return rows;
}

// sites.list: use it to import projects from GSC
const { data } = await searchconsole({ version: 'v1', auth }).sites.list();
// data.siteEntry: { siteUrl, permissionLevel: 'siteOwner'|'siteFullUser'|'siteRestrictedUser'|'siteUnverifiedUser' }[]
// Skip siteUnverifiedUser entries: queries against them fail.

// sitemaps.list (readonly OK). sitemaps.submit needs the full 'webmasters' scope, which SEOPen no longer asks for.
const sc = searchconsole({ version: 'v1', auth });
const maps = await sc.sitemaps.list({ siteUrl });
// sitemap[]: { path, lastSubmitted, lastDownloaded, isPending, isSitemapsIndex, type, errors, warnings, contents[{type, submitted}] }
// contents[].indexed is deprecated; don't use it.
await sc.sitemaps.submit({ siteUrl, feedpath: 'https://www.example.com/sitemap.xml' }); // PUT, empty 200

// urlInspection.index.inspect: 2,000/day and 600/min per property
const insp = await sc.urlInspection.index.inspect({
  requestBody: { inspectionUrl: 'https://www.example.com/some-page/', siteUrl, languageCode: 'en-US' },
});
// insp.data.inspectionResult: {
//   inspectionResultLink,
//   indexStatusResult: { verdict: PASS|FAIL|NEUTRAL, coverageState (string), robotsTxtState, indexingState,
//     lastCrawlTime, pageFetchState, googleCanonical, userCanonical, sitemap[], referringUrls[], crawledAs: DESKTOP|MOBILE },
//   richResultsResult?, ampResult?, mobileUsabilityResult (deprecated)
// }
```

### Sync strategy (pg-boss jobs, one per property)

Datasets, each stored with key `(property_id, date, search_type, ...dims)` and upserted with `ON CONFLICT DO UPDATE`:

| Table | Dimensions | Aggregation | Purpose |
|---|---|---|---|
| `gsc_totals` | `date, device, country` | `auto` (property) | Accurate site totals and charts |
| `gsc_pages` | `date, page` | `byPage` | Page performance; join key for GA4 |
| `gsc_queries` | `date, query` | `auto` | Query trends (anonymized queries are missing) |
| `gsc_query_pages` | `date, query, page` | `byPage` | Keyword-to-URL mapping; the most expensive dataset, capped at 50k rows a day |
| `gsc_appearance` (optional) | `date, searchAppearance` | `auto` | Rich-result types |

- **Types:** `web` always. Add `image`, `video`, `news` and `discover` per project only if they return rows; probe once with `dimensions:['date']` over 28 days.
- **Store dates as `date` in PT,** exactly as GSC returns them. Don't convert.

**Daily job** (for example, 07:00 local):
1. Run `dimensions:['date']`, `dataState:'all'` over the last 10 days to find the newest available date and `first_incomplete_date`.
2. For each **final** day in `[today-5 … newest final date]`, refetch all datasets with `dataState:'final'` and upsert. Re-pulling a 3–4 day window absorbs late finalization cheaply.
3. Optionally fetch `dataState:'all'` for days on or after `first_incomplete_date` into `gsc_*` with `is_final=false`. The next run's final pull overwrites them, and the UI shows those rows as preliminary.
4. Track the per-property `last_final_date` in a `gsc_sync_state` table.

**Initial backfill (16 months):**
1. Find the earliest date that has data with one cheap `['date']` query from `today − 16 months` to `today`.
2. Enqueue one job per day per dataset, **oldest first**: the oldest days fall out of GSC soonest.
3. Run with concurrency 2–3 per property and about 1–2 requests per second (far under 1,200 QPM). The load quota is what actually limits you.
4. On "quota exceeded", pause the property's queue for 15 minutes. After 3 consecutive failures, defer until the next day (pg-boss `startAfter`).
5. Do the cheap datasets first (`totals`, `pages`, `queries`), then `query_pages`.
6. Scale: about 485 days × 4 datasets × 1–2 pages ≈ 2–4k requests per property per type. That's hours spread across the day, not minutes. Make jobs idempotent so they can resume.

**URL inspection budget:** Keep a daily allowance of about 1,500 per property, leaving headroom for manual checks.
1. Spend it on a rotating list: sitemap URLs plus top `gsc_pages`, oldest `inspected_at` first.
2. Store results in `gsc_url_inspections` (one row per URL per inspection, with the verdict fields as columns plus the raw JSON).
3. Throttle to 600 QPM or less.

Built as the Indexing tab: 400 a day per project from the sitemap, stored in `indexing_pages`, so `gsc_url_inspections` keeps only inspections people ask for.

---

## 4. GA4 (Admin API + Data API)

### List properties: Admin API v1beta `accountSummaries.list`
`GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200&pageToken=...` (default page size 50, max 200; scope `analytics.readonly`).

```ts
import { analyticsadmin } from '@googleapis/analyticsadmin';

export async function listGa4Properties(auth: OAuth2Client) {
  const admin = analyticsadmin({ version: 'v1beta', auth });
  const out: { account: string; accountName: string; property: string; propertyName: string }[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await admin.accountSummaries.list({ pageSize: 200, pageToken });
    for (const a of data.accountSummaries ?? [])
      for (const p of a.propertySummaries ?? [])
        out.push({ account: a.account!, accountName: a.displayName!, property: p.property!, propertyName: p.displayName! });
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);
  return out; // property = 'properties/123456789'
}
```

### Organic landing pages: Data API v1beta `runReport`
`POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`

**Organic filter:**
- Use `sessionDefaultChannelGroup` **EXACT** `"Organic Search"` (session-scoped, so it matches `sessions` and `landingPage`).
- For Google-only traffic, AND it with `sessionSource` EXACT `"google"`.
- `sessionPrimaryChannelGroup` exists too; it follows custom channel groups, so don't use it for portability.

**Dimensions for joining with GSC:**
- `landingPage` is the path without a query string.
- `landingPagePlusQueryString` is the path with the query string.
- Add `hostName` if a property covers several hosts.
- Join on `hostName + landingPage` against GSC `page` (an absolute URL) after normalizing: drop the scheme and the query, and match trailing slashes consistently.
- Expect `(not set)` landing pages.

**Metrics:**
- `sessions`.
- `engagedSessions`: over 10 seconds, or a key event, or 2 or more views.
- `keyEvents`: the "conversions" replacement. It isn't retroactive when you mark an event as key.
- `totalRevenue`: purchase, subscription and ad revenue, minus refunds. Use `purchaseRevenue` for e-commerce only.
- Also useful: `engagementRate`, `totalUsers`, `sessionKeyEventRate`, `averageSessionDuration`, `screenPageViews`.
- For per-event rates, use `sessionKeyEventRate:<event_name>`. Check per-event count metrics with `properties/{id}/metadata` (`getMetadata`) before relying on them.

**Request limits:**
- `limit` defaults to 10,000 and allows up to **250,000** rows per request. Page with `offset` until `offset >= rowCount`.
- Up to 4 `dateRanges`. Dates are `YYYY-MM-DD`, `today`, `yesterday` or `NdaysAgo`, in the **property's time zone** (`metadata.timeZone`).
- Watch `metadata.dataLossFromOtherRow` (high-cardinality rows rolled into "(other)") and `metadata.subjectToThresholding`.

```ts
import { analyticsdata, analyticsdata_v1beta } from '@googleapis/analyticsdata';

export async function fetchOrganicLandingPages(auth: OAuth2Client, propertyId: string, start: string, end: string) {
  const data = analyticsdata({ version: 'v1beta', auth });
  const requestBody: analyticsdata_v1beta.Schema$RunReportRequest = {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'date' }, { name: 'hostName' }, { name: 'landingPage' }, { name: 'landingPagePlusQueryString' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }, { name: 'totalRevenue' }],
    dimensionFilter: {
      filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } },
    },
    // Google-only variant:
    // dimensionFilter: { andGroup: { expressions: [
    //   { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } },
    //   { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'EXACT', value: 'google' } } },
    // ] } },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: '100000',
    offset: '0',
    keepEmptyRows: false,
    returnPropertyQuota: true,
  };
  const rows: analyticsdata_v1beta.Schema$Row[] = [];
  let offset = 0;
  for (;;) {
    const res = await data.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: { ...requestBody, offset: String(offset) },
    });
    rows.push(...(res.data.rows ?? []));
    // res.data.propertyQuota.tokensPerHour.remaining etc. → record; pause if < 20%
    offset += Number(requestBody.limit);
    if (offset >= (res.data.rowCount ?? 0)) break;
  }
  return rows; // dimensionValues[i].value, metricValues[i].value (strings)
}
```

### AI assistants: Data API v1beta `runReport` by `sessionSource`
Read live when the Analytics page or MCP `get_analytics` shows it, never stored (`src/modules/google/ai-referrals.ts`). One `runReport` for the page's period: dimension `sessionSource`, metrics `sessions` and `engagedSessions`, ordered by sessions, `limit` 10,000. `sessionSource` is the utm_source when a link has one (ChatGPT adds `utm_source=chatgpt.com`) and the referrer's host otherwise, so both land in the same column. The rows are grouped by the shared list in `src/lib/ai-referrers.ts`, not by GA4's channel groups.

### GA4 quotas (Core requests, standard property)
| Quota | Standard | 360 |
|---|---|---|
| Tokens per property per day | **200,000** | 2,000,000 |
| Tokens per property per hour | **40,000** | 400,000 |
| Tokens per project per property per hour | **14,000** | 140,000 |
| Concurrent requests per property | **10** | 50 |
| Server errors per project per property per hour | 10 | 50 |
| Potentially thresholded requests per hour | 120 | 120 |

- **Token cost** rises with rows, dimensions and date-range length. Small daily reports cost single-digit tokens.
- **Always send `returnPropertyQuota: true`** and log `propertyQuota` (`tokensPerDay`, `tokensPerHour`, `tokensPerProjectPerHour`, `concurrentRequests`, `serverErrorsPerProjectPerHour`) to the job log.

**GA4 sync:**
- **Daily:** Re-pull the **last 3 days** and upsert into `ga4_organic_landing_daily (property, date, host, landing_page, landing_page_qs)`. GA4 processing can revise recent days for up to about 48 hours.
- **Backfill:** One request per month going back to the property's creation date (or 16 months, to match GSC). Run one property at a time with concurrency 2 or less, and stop if `tokensPerProjectPerHour.remaining` drops under 20%.
- **Never request** the thresholding-prone dimensions (`userAgeBracket`, `userGender`, `brandingInterest`, `audienceId`, `audienceName`) in sync jobs.

---

## 5. OAuth implementation (Next.js App Router)

### Library
- `pnpm add google-auth-library @googleapis/searchconsole @googleapis/analyticsdata @googleapis/analyticsadmin`. All are REST clients and depend on `googleapis-common@9`, which uses `google-auth-library@^11`, so one `OAuth2Client` instance works for all of them.
- **If you skip the per-API packages,** `oauth2Client.request({ url, method, data })` gives you authenticated `fetch` with automatic refresh; type the bodies yourself.
- **The `googleapis` mega-package isn't worth it** (246 MB).

### Flow
1. **`GET /api/google/connect`:**
   - `const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()`
   - Store `state` (random 32 bytes) and `codeVerifier` in a short-lived (10 minutes) httpOnly, Secure cookie on `/api/google`, encrypted. Browsers treat localhost as secure, so local http still works.
   - Redirect to `client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: SCOPES, state, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 })`.
   - `access_type=offline` is required to get a refresh token. `prompt=consent` makes Google return one on every connect; the `refresh_token` otherwise only comes back on the first authorization.
2. **`GET /api/google/callback`:**
   - Check `state`.
   - Exchange the code: `const { tokens } = await client.getToken({ code, codeVerifier })`.
   - Assert that `tokens.refresh_token` is present.
   - Check that `tokens.scope` contains both API scopes; granular consent lets users untick some.
   - Warn if `refresh_token_expires_in` is present (time-based access).
   - Read the email from `id_token` (`client.verifyIdToken`).
   - Encrypt and upsert into `google_accounts`.
3. **Using it (worker and server):** `const c = new OAuth2Client({ clientId, clientSecret, redirectUri }); c.setCredentials({ refresh_token })`.
   - The library refreshes the access token (about 1 hour lifetime) on demand and emits `c.on('tokens', t => …)`.
   - If `t.refresh_token` is ever present, re-encrypt and store it. Optionally cache `access_token` and `expiry_date` in memory only.
4. **Errors:** `invalid_grant` on refresh means the token was revoked or expired.
   - Set `google_accounts.status = 'reauth_required'`, stop that account's sync jobs, and show a "Reconnect Google" banner.
   - Don't retry in a loop, because each re-consent mints a new token and the 100-tokens-per-client limit applies.
5. **Disconnect:** `client.revokeToken(refresh_token)` (POST `https://oauth2.googleapis.com/revoke`), then delete the row. Revoking removes all scopes granted to the project, for every token that Google account gave it, so while another workspace uses the same Google account SEOpen skips the revoke and only deletes the row. One connection holds Search Console and GA4, so both stop. Projects keep their mapping and saved numbers; **Stop using** in the Sync card unlinks one source from one project and deletes its rows, connected or not.

### Encrypting refresh tokens (node:crypto, AES-256-GCM)
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
const KEY = Buffer.from(process.env.SEOPEN_SECRET_KEY!, 'base64'); // 32 bytes; generate with `openssl rand -base64 32`
if (KEY.length !== 32) throw new Error('SEOPEN_SECRET_KEY must be 32 bytes base64');

export function seal(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  c.setAAD(Buffer.from(aad));                       // e.g. google_accounts.id: binds ciphertext to its row
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
export function open(sealed: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1') throw new Error('unknown key version');
  const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
```

**`google_accounts` columns:**
- `id`, `email`, `google_sub`
- `refresh_token_enc`
- `scopes text[]`
- `status`
- `connected_at`, `last_refresh_at`, `last_error`

**Rules:**
- Never log tokens.
- Keep `.env.local` mode `600`.
- The key's version prefix (`v1`) allows rotation later.

---

## Sources
- OAuth 2.0 overview, refresh token expiration (Testing equals 7 days, 100 tokens per client per account, 6 months unused, time-based access): https://developers.google.com/identity/protocols/oauth2
- Audience / publishing status / 100-user cap / unverified warning: https://support.google.com/cloud/answer/15549945
- Verification exceptions (personal use under 100 users, click-through allowed): https://support.google.com/cloud/answer/13464323
- Sensitive scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- Web server flow (redirect URI validation, localhost exemptions, offline access, revoke): https://developers.google.com/identity/protocols/oauth2/web-server
- Installed apps (loopback, PKCE, Desktop client): https://developers.google.com/identity/protocols/oauth2/native-app
- Manage OAuth clients (secret shown once, 6-month inactive deletion, propagation delay): https://support.google.com/cloud/answer/15549257
- Consent screen and credential steps: https://developers.google.com/workspace/guides/configure-oauth-consent, https://developers.google.com/workspace/guides/create-credentials
- Search Console limits: https://developers.google.com/webmaster-tools/limits
- searchanalytics.query: https://developers.google.com/webmaster-tools/v1/searchanalytics/query
- Getting all your data (50k rows per day per type, paging, 2–3 day lag): https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data
- Sites, sitemaps, URL inspection: https://developers.google.com/webmaster-tools/v1/sites, https://developers.google.com/webmaster-tools/v1/sitemaps, https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult
- GA4 Data API quotas: https://developers.google.com/analytics/devguides/reporting/data/v1/quotas
- GA4 dimensions and metrics: https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema
- runReport: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
- Admin API accountSummaries.list: https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accountSummaries/list
- npm (checked 2026-10-29): google-auth-library 11.3.2, @googleapis/searchconsole 11.0.1, @googleapis/analyticsdata 10.1.1, @googleapis/analyticsadmin 22.0.1, googleapis 188.0.0 (246 MB unpacked)
