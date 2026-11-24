# DataForSEO for SEOPen

Research date: 2026-10-29. Prices come from dataforseo.com/pricing/* and the pricing update of 2026-07-01, which raised most Labs, Backlinks, On-Page and Keywords Data rates by 20% and removed the monthly commitments. Limits come from docs.dataforseo.com/v3. Call `GET /v3/appendix/user_data` (free) to see the live price tree in `result[0].price`. Use that to check these figures before you trust them.

## 0. Account setup and ledger notes

- **Sign-up.** Make an account at https://try.dataforseo.com/65m65rikt8ny (an affiliate link, so SEOpen may earn a commission).
- **API password.** `GET /v3/appendix/user_data` (free) checks the credentials. It returns 40100 when `.env.local` holds the dashboard password: the API uses a separate, generated **API password** from https://app.dataforseo.com/api-access.
- **Access.** The Backlinks API and the AI Optimization API work on a pay-as-you-go account with no subscription (see §2, Backlinks).

**Ledger notes:**
- `task_get` responses repeat the original task's `cost`. The client therefore skips the ledger for `free: true` calls.
- Standard `llm_responses` only prepay about $0.0102 at `task_post`. The real cost is the base price plus `money_spent`, which the AI module adds with `recordLedgerAdjustment`.
- On-Page refunds the pages that weren't crawled. The audit module records that as a negative adjustment, on every path that ends a crawl and before the crawl closes, in one transaction with the crawl row. A failed write leaves the crawl open, and the next poll records the refund. A crawl stopped at 12 hours is reckoned from its summary after `force_stop`, or the last poll's count if the summary can't be read. A task DataForSEO no longer has (40401, 40403) is reckoned from the last poll's count, since whether DataForSEO refunds such a task isn't confirmed.
- A crawl post whose answer never came back (a network error, an HTTP 5xx, which `task_post` doesn't retry, or a worker that died) leaves the crawl in `posting`, and the poller looks the task up by its tag after 10 minutes (`recoverPosting`). `on_page/id_list` lists the account's tasks; ids another crawl has stored are skipped and every other one's tag is checked, and a full list (1,000) means look again later rather than post twice. An adopted task the ledger has no `task_post` charge for since the crawl was created is charged its estimate then, so the refund at the end has a charge to come off.
- The crawl's tag is `seopen-audit-<db>-<crawl id>`, where `<db>` is a 10-character hash of the database's host and name (never its credentials), so a local database using the same DataForSEO account as production can't adopt production's task. Older tags with no `<db>` are never adopted.
- Local SEO writes to the ledger as module `local`: the Live listing search and each grid task. Its `tasks_ready` and `task_get` calls are free. A live test confirmed $0.0006 per Maps task at depth 20.

Expected cost of a smoke test at list prices:

| Call | Expected `cost` |
|---|---|
| `dataforseo_labs/google/domain_rank_overview/live` (example.com, US/en) | $0.01212 ($0.012 per task + $0.00012 × 1 item) |
| `dataforseo_labs/google/keyword_overview/live` ("garden design") | $0.01212 |
| `serp/google/organic/live/advanced` (depth 10) | $0.002 |
| `on_page/instant_pages` (https://example.com, no JS) | $0.00015 |
| **Total** | **about $0.027** |

## 1. Platform basics

- **Auth:** HTTP Basic with the API login and API password. Base URL `https://api.dataforseo.com/v3/`. A free sandbox at `https://sandbox.dataforseo.com/v3/` returns sample responses with the same shape.
- **Billing:** prepaid and pay-as-you-go. The minimum top-up is **$50**. New accounts get **$1 trial credit** that never expires, and balances never expire. There is no subscription and no per-seat fee. You can set daily spend limits per account or per endpoint in the dashboard (exceeding one returns 40203). Set one as a backstop behind SEOPen's own cap. SEOpen emails `OWNER_ALERT_EMAIL` on the first 40203 of a UTC day (`noteDailyLimit` in `src/lib/dataforseo/balance.ts`).
- **Global limits:** up to 10,000 calls per minute per account (40202 when exceeded), and **at most 30 simultaneous requests** (40209). Task POST accepts up to 100 tasks per call (40006 above that). Each Live call carries one task, except `on_page/instant_pages`, which takes 20.
- **Response envelope:** `status_code`, `status_message`, `cost` (USD, whole call), `tasks_count`, `tasks_error`, and `tasks[]`. Each task has `id`, `status_code`, `cost`, `result_count`, `path`, `data` (echoes the request), and `result[]`. **Always check each task's `status_code`.** A top-level 20000 can still contain failed tasks. Write `tasks[].cost` to the ledger.
- **Modes:**
  - **Live** answers in a single POST and costs more.
  - **Standard** is `task_post`, then `tasks_ready`, then `task_get`. It's cheaper but asynchronous, from minutes to 72 hours depending on the API.
  - `tasks_ready` is free, allows 20 calls per minute, returns up to 1,000 tasks, and covers the last 3 days. Results can be fetched for about 30 days (after that, 40403 "results expired").
- **Postback and pingback:** set `postback_url` (results are pushed) or `pingback_url` (a GET notification). **SEOPen doesn't use these** (a local install can't receive them). It polls `tasks_ready` instead.

## 2. Endpoint tables per module

### Domain overview (DataForSEO Labs, Google): Live only

Standard rate: **$0.012 per task + $0.00012 per returned item**. `include_clickstream_data=true` doubles the price. Domain data is updated weekly.

| Feature | Endpoint (POST) | Key params | Price | Store |
|---|---|---|---|---|
| Overview | `dataforseo_labs/google/domain_rank_overview/live` | `target` (no scheme or www), `location_code`, `language_code`, `ignore_synonyms` | about $0.0121 (1 item) | `metrics.organic.{etv,count,pos_1,pos_2_3,pos_4_10…pos_91_100,is_new,is_up,is_down,is_lost,estimated_paid_traffic_cost}` and the same under `metrics.paid` |
| Ranked keywords | `…/ranked_keywords/live` | `limit` ≤1000 (default 100), `offset`, `filters` (≤8), `order_by`, `item_types` (`organic`,`paid`,`featured_snippet`,`local_pack`,`ai_overview_reference`), `historical_serp_mode`, `load_rank_absolute` | $0.012 + $0.00012/row (1,000 rows = $0.132) | `total_count`, and per item `keyword_data.keyword`, `keyword_info.{search_volume,cpc,competition}`, `keyword_properties.keyword_difficulty`, `ranked_serp_element.serp_item.{type,rank_group,rank_absolute,url,relative_url,etv,is_new,rank_changes}` |
| Top pages | `…/relevant_pages/live` | `target`, `limit`, `filters`, `order_by` | $0.012 + per page | `page_address`, `metrics.organic.{etv,count,pos_1…}` |
| Competitors | `…/competitors_domain/live` | `target`, `limit`, `exclude_top_domains`, `item_types` | $0.012 + per domain | `domain`, `avg_position`, `sum_position`, `intersections`, `full_domain_metrics`, `metrics` |
| Keyword gap | `…/domain_intersection/live` | `target1`, `target2`, `intersections` (`true` = both rank, `false` = target1 ranks and target2 doesn't, which is the gap), `limit` ≤1000, `filters`, `order_by` | $0.012 + per keyword | `keyword_data`, `first_domain_serp_element`, `second_domain_serp_element` (`rank_group`, `url`, `etv`) |
| Keywords for site | `…/keywords_for_site/live` | `target`, location, language, `include_subdomains` (default true), `limit` ≤1000 (default 100), `filters`, `order_by` (default `relevance,desc`; volume is `keyword_info.search_volume`) | $0.012 + per keyword | per item `keyword` and `keyword_info.search_volume` at the top level (no `keyword_data`). The guided setup's keyword ideas |
| SERP competitors | `…/serp_competitors/live` | `keywords[]` (required, ≤200, lowercased), location, language, `include_subdomains` (default true), `item_types` (default `organic`,`paid`; also `featured_snippet`,`local_pack`), `limit` ≤1000 (default 100), `offset`, `filters` (≤8, e.g. `["median_position","<=",20]`), `order_by` (≤3, default `rating,desc`) | $0.012 + per domain returned; keywords aren't a billing unit (docs and pricing page, checked 2026-11-02: the pricing page doesn't name it, it falls under "every Labs endpoint except" the listed exceptions) | per item `domain`, `avg_position`, `median_position`, `rating` (sum of 100 minus each position), `etv`, `keywords_count` (how many of the keywords it ranks for), `visibility`, `relevant_serp_items`, `keywords_positions` (keyword → positions). The guided setup's competitors: searches made from the homepage and the unbranded keywords, so namesakes that share only brand searches don't show up |
| History | `…/historical_rank_overview/live` | `target`, location, language, `date_from`/`date_to` | **$0.12 + $0.0012 per month item** (an exception: 10× the normal rate) | per month `year`, `month`, `metrics.organic.{etv,count,pos_*}` |
| Bulk traffic | `…/bulk_traffic_estimation/live` | `targets[]` ≤1000, `item_types` | $0.012 + per target | `target`, `metrics.organic.etv`, `metrics.paid.etv` |
| Bulk traffic history | `…/historical_bulk_traffic_estimation/live` | `targets[]`, dates | $0.12 + $0.0012 per domain | per month etv |
| Data freshness | `dataforseo_labs/status` | | free | `last_update` |

### Keyword research

The Overview tab lists this workspace's one-keyword lookups from the last 7 days in the current market (`src/modules/keywords/recent.ts`). It reads the cached responses the workspace paid for, so the list spends nothing, and a re-open doesn't move a keyword up the list.

| Feature | Endpoint | Mode | Key params | Price | Store |
|---|---|---|---|---|---|
| Overview | `dataforseo_labs/google/keyword_overview/live` | Live | `keywords[]` ≤700, location, language, `include_serp_info` | $0.012 + $0.00012/keyword. Keywords with no data aren't charged | `keyword_info.{search_volume,cpc,competition,competition_level,monthly_searches[]}`, `keyword_properties.keyword_difficulty`, `search_intent_info.main_intent`, `avg_backlinks_info`, `serp_info.serp_item_types` |
| Suggestions (phrase match) | `…/keyword_suggestions/live` | Live | `keyword`, `limit` ≤1000, `filters`, `include_seed_keyword` | $0.012 + per row | same `keyword_data` shape |
| Related (People Also Search, depth 0–4) | `…/related_keywords/live` | Live | `keyword`, `depth` 0–4, `limit` ≤1000 | $0.012 + per row | `keyword_data`, `depth`, `related_keywords[]` |
| Ideas (category based) | `…/keyword_ideas/live` | Live | `keywords[]` (≤200, from memory: verify), `limit` ≤1000 | $0.012 + per row | `keyword_data` shape |
| Questions | `keyword_suggestions` with a filter on `keyword` (`like "how %"`, etc.) or `related_keywords` | Live | | | |
| Difficulty | `…/bulk_keyword_difficulty/live` | Live | `keywords[]` ≤1000 | $0.012 + $0.00012/keyword | `keyword`, `keyword_difficulty` |
| Intent | `…/search_intent/live` | Live | `keywords[]` ≤1000, `language_code` | $0.012 + $0.00012/keyword | `keyword_intent.{label,probability}`, `secondary_keyword_intents[]` |
| Google Ads volume | `keywords_data/google_ads/search_volume/task_post` or `/live` | Std (1–3 h) or Live | `keywords[]` ≤1000, location, language | **$0.06 per task (Std) or $0.09 (Live), whatever the keyword count**. Always fill the task with up to 1,000 keywords. Live allows only **12 requests per minute** | `search_volume`, `competition`, `competition_index`, `cpc`, `low_top_of_page_bid`, `high_top_of_page_bid`, `monthly_searches[]` |
| Live SERP | `serp/google/organic/live/advanced` | Live | see Rank tracking | $0.002 per 10 results | see below |

### Rank tracking: SERP API, Google Organic

| Mode | Endpoint | Price per SERP page (10 results) | Depth 100 | Turnaround |
|---|---|---|---|---|
| Standard, normal (`priority: 1`, default) | `serp/google/organic/task_post` → `tasks_ready` → `task_get/advanced/{id}` | **$0.0006** | $0.006 | minutes, up to about 1 h |
| Standard, high (`priority: 2`) | same | $0.0012 | $0.012 | faster |
| Live | `serp/google/organic/live/advanced` (or `/live/regular`) | $0.002 | $0.02 (Live max depth is 200) | seconds |

- **Params:** `keyword` (≤700 characters; operators such as `site:` multiply the price by 5), `location_code` (e.g. 2840 for the US) or `location_name` or `location_coordinate` ("lat,lng,radius"), `language_code`, `device` (`desktop`|`mobile`), `os` (`windows`|`macos`|`android`|`ios`), `depth` (default 10, max 700 on task_post), `priority`, `se_domain`, `tag` (≤255 characters, use it for the SEOPen keyword id), `stop_crawl_on_match` (≤10 targets with `match_type` `domain`|`with_subdomains`|`wildcard`; you pay only for the pages crawled until the match), `load_async_ai_overview` (+1 base price), `resolve_poisoned_results` (+1 base price per task at any depth; see below), `people_also_ask_click_depth` 1–4 (+$0.00015 per click), `calculate_rectangles` (+1 base price).
- **Depth billing:** you pay one base price for each 10 results, rounded up. Google no longer serves 100 results per page, so depth 100 means 10 page fetches at 10× the price.
- **Store:**
  - Result: `check_url`, `datetime`, `se_results_count`, `item_types[]`, `spell`.
  - Per item: `type`, `rank_group`, `rank_absolute`, `page`, `domain`, `url`, `title`, `description`, and `breadcrumb`.
  - Keep every SERP-feature item type, to support feature tracking and share of voice.
- **Polling:** `tasks_ready` allows 20 calls per minute and returns at most 1,000 tasks per call. Fetch each listed `endpoint_advanced`. Results are kept about 30 days. Rank's `pollOnce` keeps a 40106 partial result and gives up on a 40101 at once, rather than holding the project's one active run for 6 hours. Both have only been seen on Live, which rank tracking doesn't use.
- **One look isn't enough (measured 2026-11-03).** Four depth-20 looks at 12 local keywords, three minutes apart on the Standard queue, shared on average 42% of their top 10s. A domain in the top 10 on one look was missing from the whole top 20 on 56% of the others, and from all three of three others on 25%. Three looks from the city (47%) and six non-local keywords like "how to tie a tie" (51%) were no steadier, so it isn't local results or the location. Every page looked complete (median 19 organic results, no errors, 0 `google.com/goto` links), so a page can't be judged by its shape. This fits public reports that Google has served automated searches incomplete pages since September 2026, but the numbers only show that the pages disagree, not whose doing that is. Replaying the looks through the rules below, the tracked site was found on 59% of first looks and 88% after rechecks, at 1.58 looks per ranking keyword.
- **Live is no steadier than Standard (measured 2026-11-03).** On 18 keywords over three rounds at depth 20, top-10 overlap was 45% on Live and 44% on Standard for local keywords, and 58% and 62% for non-local ones, at about 3.3x the price, so rank tracking stays on Standard. 3 of 54 Live looks failed or came back partial (40101, 40106), against 0 of 54 on Standard. `google.com/goto` links appeared only on Live, and `serpTarget` (`src/lib/dataforseo/serp-target.ts`) recovers the real site from each result's breadcrumb. It keeps only the breadcrumb's origin as the URL, because the path in a breadcrumb is display text and is sometimes cut short, and returns `originOnly: true` with that path as `breadcrumb` (such as "blog › backlink-checkers"). The MCP `serp` tool gives these as `url_is_origin_only` and `breadcrumb`, and the Keywords top 10 and the AI Overview checker mark such a link "Domain only: Google hid the full link". Rank tracking stores the origin as the ranking URL with no such mark (`rank_results` has no column for it).
- **Google's redirect limit (2026-11-16):** since about Oct 30 Google limits how many `google.com/goto` links on one results page can be followed, and they reached the Standard queue too (EverGrow measured 59.9% of DataForSEO's organic results without a real URL on Oct 31; SerpApi, Bright Data and Oxylabs were worse). DataForSEO's Standard Normal priority now follows them all, so task_post rank checks have real URLs again but run slower (EverGrow: median 75 s at depth 10, 960 s at depth 100). Live and High priority follow them only with `resolve_goto_urls: true`, which adds at least 40 s and can run to 260 s; a link it can't follow comes back unchanged. No price change is stated. Content briefs (`briefSerpSpec`, so they can read the top 3) send it with `retries: 0` (measured Nov 16: $0.002, no surcharge, all top-10 URLs real), and `FETCH_TIMEOUT_MS` is 270 s so the client doesn't drop a paid answer. A brief still reuses Keyword research's saved top 10 when its top 3 have real addresses. Keyword research, the refresh panel, MCP `serp` and the AI Overview checker stay fast and keep the breadcrumb fallback.
- **`site:` searches stopped working (2026-11-16):** through Live advanced, `site:` queries mostly fail with 40101 (no charge) or answer with 0 organic results at $0.01, with or without `resolve_goto_urls`. With up to 3 tries each they confirmed 1 of 7 pages URL Inspection showed as indexed. Ordinary keywords on the same calls were fine at $0.002. So the free index checker no longer searches (`src/modules/tools/indexed.ts`).
- **Poisoned results and the fix (2026-11-17):** Google serves automated searches "poisoned" pages: normal-looking, with most organic results swapped for unrelated ones (DataForSEO's posts, Semji's tracker). On 2026-11-16 DataForSEO added `resolve_poisoned_results` to the Google Organic SERP API, Standard and Live: page 1 is compared with Google's Web filter (`udm=14`) and, when they differ, the organic results come from the Web filter, later pages included, each marked `checks: ["from_web"]`. AI Overviews and other features are left as collected. It costs one base price per task whatever the depth, clean pages included, and can't be combined with `udm=14` in `url` or `search_param`. Measured from one US city (12 keywords, 10 of them a local business's, depth 20, three looks each, Standard): without it the top 10 matched between looks 39% (local) and 34% (other) of the time and the tracked site showed in 4 of 30 looks; with it 76% and 87%, 24 of 30, $0.0016 a look against $0.0010, and 615 of 666 organic results came from the Web filter. Asking for the Web filter directly (`search_param: "udm=14"`, no surcharge) gave 88% and 100% and 30 of 30 at $0.0011, but has no features or AI Overview, and its positions differed from the fix's by up to 10 places on 3 of 10 keywords (for example 16 against 7), so its positions can't be taken as they are: checked in a real browser on Google set to the same place with `pws=0`, the fix's positions matched (7th, not the Web filter's 16th, on one keyword; about 19th against 13 from the fix and 17 from the Web filter on another). A daily check of that project took 54 rechecks and left 18 keywords not confirmed before the fix; the two checks after it took 30 and 26 rechecks and left none not confirmed, for about the same cost. Live searches can fail with 40101 about half the time on some keywords with or without the fix, so MCP `serp` answers "Try again in a minute" there; nothing is charged. Also checked: Live with the fix, `resolve_goto_urls` and the async AI Overview together cost $0.006 (status 20000), and a depth-100 task_post with the AI Overview and the fix posted at $0.00585 and finished 20000. Rank tasks (`tracker.ts`, rechecks included) and the live top 10 (`serpSpec`: keyword research, briefs, page refresh, wrong page type, MCP `serp`) send it (`src/lib/dataforseo/poisoned.ts`); the AI prompt module's weekly AI Overview tasks and the public AI Overview checker don't. Estimates: `estimateCheckCost` adds one base price per task, `serpSpec` is $0.004 ($0.02 with operators, assuming the fix bills at the same multiple) and a brief's top 10 $0.006.
- **Rechecks (`src/modules/rank/recheck.ts`):** a keyword that ranked in the last 14 days and comes back missing, or 10 or more places below its best of those 14 days, gets up to two more looks at the normal price, and the best look is stored. When all three miss, it keeps its last position, shown as "not confirmed" and stored as `not_checked` (three looks still miss a real top-10 result about a quarter of the time), and it's recorded as not ranking on the fourth such day in a row. A not-confirmed keyword still counts toward every figure built from positions, and each says how much rests on it wherever that changes the figure as it reads: On page one, Visibility, Est. traffic, Share of voice and Tracked position on Rankings (Tracked position only when the average without them reads differently), the newest check under Rankings' Trend chart, Visibility and Top 3 on the Overview's Rankings card, Tracked position in the Overview's strip and What changed row, and on Competitors: Visibility, which adds that the gap to competitors isn't measured, since the stored row repeats the last results page for every domain on it; Share of voice; Tracked position; Competitors ahead, with the count on confirmed positions alone when it differs; the sentence, with what confirmed positions alone would say when that differs; and the newest check under Over time, counted in keywords. Competitors carries deep positions forward the same way for every domain, rivals included, from 14 days before its window (`loadDomainResultsToCarry`). How many days a keyword that a real sweep misses should keep its position is still an open question. A keyword's own page doesn't state a not-confirmed position as found: its sentence gives only the last sighting, its figure shows no move, its header and Google results say when the repeated results were last seen, and Check history marks the row. The Overview sentence says how many of a page one gain aren't confirmed, and a gain that rests wholly on them is said in a neutral tone: neither the sentence nor the figure calls it good, and What changed leaves it out. It shows no move on Rankings or the Overview, and the Rankings sentence names any it would otherwise have called a gain. The ledger and `rank_runs.cost_usd` hold the real cost. Check now and Deep check show the upper bound, three looks per keyword.
- **Search Console as a reason to look again (2026-11-04):** a keyword with no recent position gets the same two extra looks when it comes back missing and its Search Console average over the last 14 days (`gsc_queries`, exact query, by impressions) is within the check's depth. That average covers every location and device, so it never becomes a position: three misses are stored as not ranking. It stops after 3 earlier days in a row with no position from this place, so a real miss costs at most 6 extra looks until the keyword is found again. Rows from before places were recorded don't count towards the 3.
- **Early misses (2026-11-05):** a keyword with no recent position and no Search Console figure gets the same extra looks for its first 3 days missing from a place, so a new keyword or a new city isn't judged on one look. A Search Console average beyond the check's depth still means no extra looks. At depth 20 that's at most 6 extra looks, about $0.0063 a keyword, until it's found. After that, one look a day, and the first look to find it brings the 14-day recheck protection.
- **Measured from one city (2026-11-05):** a local business had 10 keywords with no position after a morning check. Three fresh depth-20 looks at each found 5 of the 10, at positions 2 to 7, in 8 of 15 looks at those five: one in all three looks, another in only one. One depth-20 look at each from the whole US found none, so the place matters too. So those rows were false, and a keyword stays false until a look finds it. One keyword missed all three looks from the city while Search Console had it at 5.6 with 582 impressions.

**Rank-tracking cost per keyword per month (Standard, normal priority, one device):**

| Schedule | Depth 10 | Depth 20 | Depth 100 | Depth 100 + `stop_crawl_on_match` (assumed average of 4 pages) |
|---|---|---|---|---|
| Daily (30/mo) | $0.018 | $0.036 | $0.18 | about $0.072 |
| Weekly (4.33/mo) | $0.0026 | $0.0052 | $0.026 | about $0.010 |

| Keywords | Daily d10 | Daily d20 | Daily d100 | Weekly d10 | Weekly d100 |
|---|---|---|---|---|---|
| 100 | $1.80 | $3.60 | $18.00 | $0.26 | $2.60 |
| 500 | $9.00 | $18.00 | $90.00 | $1.30 | $13.00 |
| 1000 | $18.00 | $36.00 | $180.00 | $2.60 | $26.00 |

These are before `resolve_poisoned_results`, which adds one base price a look: $0.018 a month daily and $0.0026 weekly at any depth. High priority doubles these figures, and Live multiplies them by 3.3. Tracking both mobile and desktop doubles them, and adding async AI Overview doubles them as well.

### Local SEO: SERP API, Google Maps (added 2026-11-02)

| Use | Endpoint | Mode | Price | Params SEOpen sends |
|---|---|---|---|---|
| Find the listing | `serp/google/maps/live/advanced` | Live | about $0.002 per search | `keyword` "<name> <city>", the project's `location_code` and `language_code`, `device: "desktop"`, `depth: 20`. Cached 24 h per workspace, so picking a listing repeats the search for free |
| Guided setup, a local business's competitors | `serp/google/maps/live/advanced` | Live | about $0.002 per search, 3 at most | `keyword` "<service> <town>", the town's own `location_code` from `dfs_places`, the project's `language_code`, `device: "desktop"`, `depth: 20`. Cached a week per workspace |
| Grid check | `serp/google/maps/task_post` → `tasks_ready` → `task_get/advanced/{id}` | Standard, `priority: 1` | **$0.0006 per task** at depth 20 (one page of Maps results) | one task per grid point per keyword: `keyword`, `location_coordinate` "lat,lng,<zoom>z" (zoom 15, 14, 13 or 12 for a 1, 3, 5 or 10 mile radius), the project's `language_code`, `device: "mobile"`, `os: "android"`, `depth: 20`, `tag` "local:<checkId>:<pointId>". Up to 100 tasks per post |

- **Search from the town:** checked live on 2026-11-03, by coordinates. A service plus a city name ("hr consultant <city>, <state>") searched from that city returned local firms; from the middle of the US it returned no results. The bare service searched from three nearby towns also returned local firms, while organic results for the same searches were mostly job boards. A city `location_code` on this endpoint works: a live run of the guided setup for an HR consultancy got status 20000 and local firms from all three towns, at $0.002 a search.
- **Store:** per `maps_search` item `rank_group`, `title`, `cid`, `place_id`, `category`, `address`, `domain`, `rating.{value,votes_count}`, and `latitude`/`longitude` for the listing search. Paid ads are ignored.
- **Matching:** our listing is the item with the same `cid` or `place_id`. Names are never compared.
- **Failed vs not found:** a task that isn't 20000, or a 20000 with no listings at all, is Failed. Only an answer that lists other businesses and not ours is Not found. 40601/40602 mean not ready yet; 5xxxx errors are retried on later polls for 6 hours.
- **Polling:** `local.poll` every 2 minutes. A task missing from `tasks_ready` after 15 minutes is fetched directly; a point with no result after 3 days fails.
- **Cost per check:** points × keywords × $0.0006. A 5×5 grid is $0.015 per keyword, a 7×7 grid $0.0294. Weekly, 5 keywords on a 5×5 grid is $0.075 a check, about $0.32 a month.

### Site audit: On-Page API

Crawl price, per crawled page:

| Option | Price per page |
|---|---|
| Base | **$0.00015** |
| `load_resources` | $0.00045 |
| `enable_javascript` | $0.0015 |
| `enable_browser_rendering` (includes JS and resources, needed for CWV) | $0.0051 |
| `enable_content_parsing` | +$0.00015 |
| `calculate_keyword_density` | +$0.00015 |

You're charged for pages actually crawled. If `max_crawl_pages` is higher than the site's page count, the difference is refunded when the task finishes. The GET endpoints below read the stored crawl. The docs say you're charged only for posting the task, but confirm this in the ledger.

| Endpoint | Purpose / key fields |
|---|---|
| `on_page/task_post` | `target` (no scheme or www), `max_crawl_pages` (required), `start_url`, `max_crawl_depth`, `crawl_delay` (default 2000 ms), `respect_sitemap`, `custom_sitemap`, `allow_subdomains`, `enable_javascript`, `load_resources`, `validate_micromarkup`, `check_spell`, `checks_threshold`, `disable_cookie_popup`, `custom_user_agent`, `browser_preset`, `switch_pool`, `return_despite_timeout`, `tag`. Up to 100 tasks per call |
| `on_page/tasks_ready` | completed crawl ids |
| `on_page/summary/{id}` | `crawl_progress` (`in_progress`|`finished`), `crawl_status.{max_crawl_pages,pages_in_queue,pages_crawled}`, `domain_info.{cms,server,ssl_info,checks,total_pages,crawl_start,crawl_end}`, `page_metrics.{onpage_score,broken_links,broken_resources,duplicate_title,duplicate_description,duplicate_content,non_indexable,links_internal,links_external,redirect_loop,checks{…}}` |
| `on_page/pages` | per page: `url`, `status_code`, `meta.{title,description,htags,canonical}`, `onpage_score`, `page_timing`, `checks{no_h1_tag,title_too_long,is_4xx_code,…}`, `resource_errors`. Takes filters and a limit of up to 1000 |
| `on_page/resources`, `pages_by_resource` | images, CSS, JS: `status_code`, `size`, `fetch_timing` |
| `on_page/duplicate_tags` | groups by `duplicate_title` and `duplicate_description` |
| `on_page/duplicate_content` | free. Takes one `url`; returns `items[].total_count` and `pages[].{similarity, page[]}`. Similarity is 0 to 10 (SimHash), 6 or more by default. The docs don't say whether nav and footer text counts, or give the order of `pages` |
| `on_page/links` | `link_from`, `link_to`, `type`, `dofollow`, `is_broken`, `direction` |
| `on_page/redirect_chains`, `non_indexable` | `reason`: `robots_txt`, `meta_tag`, `http_header`, `attribute`, `too_many_redirects` |
| `on_page/force_stop` | abort a crawl |
| `on_page/instant_pages` (Live) | one URL per task, 20 tasks per call, at most 5 URLs on the same domain, $0.00015 per page |
| `on_page/lighthouse/task_post` / `live/json` | **$0.005 per page**, the same in both modes (Live times out after 120 s). Params: `url`, `for_mobile`, `categories`, `audits` |
| `on_page/page_screenshot` | $0.0048 |

**Polling a crawl:** poll `on_page/summary/{id}` every 30–60 s until `crawl_progress == "finished"`, or poll `on_page/tasks_ready` every 60 s. Then page through `pages` with limit 1000 and offset. Every 2 s per page (the default delay), a 500-page crawl takes about 10–20 minutes. Nothing here times a smaller crawl, so the app gives Free's 100 pages the pace rather than a time (`crawlTimeLine`). SEOpen polls every 30 s while a crawl runs: `audit.poll` runs once a minute (cron's finest step) and, when a crawl is still going, looks again 30 s later in the same run (`SECOND_POLL_MS`). The summary and import calls are free, so that's at most two summary calls a minute per running crawl and no extra spend.

### Backlinks API: Live only

- **Price:** **$0.024 per request + $0.000036 per row**, the same for every `/backlinks/*` endpoint. That's up to 1,000 rows per request, and 1,000 rows cost $0.06. Filtering and sorting are free.
- **Concurrency:** 30 simultaneous requests.

| Feature | Endpoint (`backlinks/…/live`) | Store |
|---|---|---|
| Summary | `summary` (`target`, `include_subdomains`, `internal_list_limit`, `backlinks_status_type`) | `rank`, `backlinks`, `backlinks_spam_score`, `referring_domains`, `referring_domains_nofollow`, `referring_main_domains`, `referring_ips`, `referring_subnets`, `broken_backlinks`, `referring_links_tld`, `referring_links_types`, `first_seen` |
| Backlinks list | `backlinks` (`mode`: `as_is`|`one_per_domain`|`one_per_anchor`, `limit` ≤1000, `filters`, `order_by`) | `url_from`, `domain_from`, `url_to`, `anchor`, `dofollow`, `rank`, `domain_from_rank`, `first_seen`, `last_seen`, `is_new`, `is_lost`, `item_type` |
| Referring domains | `referring_domains` | `domain`, `rank`, `backlinks`, `first_seen`, `lost_date`, `referring_pages` |
| Anchors | `anchors` | `anchor`, `backlinks`, `referring_domains`, `first_seen` |
| Top pages | `domain_pages`, `domain_pages_summary` | per page backlinks and referring domains |
| History (monthly) | `history` (`date_from`, `date_to`) | `date`, `rank`, `backlinks`, `referring_domains`, `new_*`, `lost_*` |
| Timeseries | `timeseries_summary`, `timeseries_new_lost_summary` (`group_range` day/week/month) | `date`, `new_backlinks`, `lost_backlinks`, `new_referring_domains`, `lost_referring_domains` |
| Link gap | `domain_intersection` (`targets` map, up to 20 from memory: verify; `exclude_targets`), `page_intersection` | referring domains shared by competitors and missing for us. The intersection's `rank` rates a domain's links to each target, not the domain itself, so it changes with the targets; `link_gap` shows it as `link_rank` (2026-11-17) |
| Competitors | `competitors` | domains with an overlapping link profile |
| Bulk | `bulk_ranks`, `bulk_backlinks`, `bulk_referring_domains`, `bulk_spam_score`, `bulk_new_lost_backlinks`, `bulk_new_lost_referring_domains`, `bulk_pages_summary` (≤1000 targets per request) | one row per target |

The summary's `referring_domains` and the `referring_domains` list's `total_count` are counted differently, even with the same `target`, `include_subdomains` and `backlinks_status_type`: One domain fetched minutes apart on 2026-10-29 gave 271 and 77 (349 backlinks against 159 summed over the list). The docs don't say why. So the Backlinks overview labels its count as the summary's and the Referring domains tab labels its count as the list's.

**Minimum commitment: none.**
- The 2026-07-01 pricing update says: "The $100 monthly commitment for the Backlinks API and LLM Mentions API has been removed."
- `user_data.backlinks_subscription_expiry_date` is now marked deprecated.
- There's no Backlinks-specific trial any more. The general $1 trial credit and the free sandbox cover testing.
- Error 40204 ("visit plans and subscriptions to activate your subscription") is still listed in the errors table. Handle it, but it shouldn't occur.
- Some older DataForSEO pages and third-party pages still mention the $100 per month minimum and a 14-day trial. Those are out of date.

### AI visibility: AI Optimization API

Gemini's citation links go through `vertexaisearch.cloud.google.com/grounding-api-redirect/`, and the real site is only in the annotation title. `extractCitations` (`src/modules/ai/detect.ts`) reads the domain from there. Pages read stored citations through `readCitation`, so answers stored before 2026-11-03 count under the title's site too. A redirect whose title isn't a domain hides its site: it shows as "Gemini link, source hidden" and counts under no domain.

Since 2026-11-20 a run follows each redirect once when the answer comes in and stores the page it leads to (`src/modules/ai/gemini-links.ts`). Only Google's redirect is requested, never the page: one GET through `safeFetch` with no redirects followed, stopped after the headers, 4 seconds at most, at most 300 per run. A redirect that can't be followed (expired, slow, or over the cap) is stored as it came and read as above. Answers stored before then keep their redirects: they have expired, so there is nothing to backfill them from.

| Feature | Endpoint | Mode | Price | Notes / store |
|---|---|---|---|---|
| LLM mentions (database of AI answers) | `ai_optimization/llm_mentions/search_mentions/live`, `target_metrics`, `multi_target_metrics`, `top_mentioned_domains`, `top_mentioned_pages`, `top_mentioned_brands`, `historical`, `timeseries_delta`, `timeseries_new_lost`, plus `*_lite` variants | Live only | **$0.10 per task + $0.001 per row** | `target[]` ≤10 domain or keyword entities, `platform` `google` (AI Overview) or `chat_gpt`. ChatGPT data covers US/English only. Store `question`, `answer`, `sources[].{domain,url,rank}`, `ai_search_volume`, `platform`, `model_name`, `first_response_at`, `last_response_at`, `brand_entities` |
| Prompt tracking, API models | `ai_optimization/{chat_gpt,claude,gemini}/llm_responses/task_post|live`, `perplexity/llm_responses/live` (Live only), `…/models` | Std or Live | Live: $0.0006 + LLM token cost. Std: $0.0002 + a $0.01 prepayment, with the excess refunded | Params: `user_prompt`, `model_name`, `web_search`. Store the response text, `annotations`/citations, tokens and `money_spent` |
| Prompt tracking, real UI scrape | `ai_optimization/{chat_gpt,gemini}/llm_scraper/task_post|live/advanced` | Std (up to 45 min), Priority, or Live | **$0.0012 (Std)**, $0.0024 (Priority), $0.004 (Live) per result | This is the cheapest way to see what users actually see, including citations |
| AI search volume | `ai_optimization/ai_keyword_data/keywords_search_volume/live` | Live | $0.01 + $0.0001 per keyword (≤1000) | `ai_search_volume`, `ai_monthly_searches` |
| Google AI Overview | `serp/google/organic/*` with `load_async_ai_overview: true` | Std or Live | +1 base price (Std +$0.0006). Refunded if no AIO is present | item `type: "ai_overview"`: `markdown`, `items[]`, `references[].{domain,url,title}`, `asynchronous_ai_overview` |

### City targeting: what takes a city code

Checked live on 2026-11-03 with a city `location_code` (one US city):

| Data | Takes a city? | Evidence |
|---|---|---|
| SERP (`serp/google/organic/*`) | Yes | Answered from the city (its `location_code` in the result), with a different top 5 from 2840 |
| Google Ads volume (`keywords_data/google_ads/search_volume/*`) | Yes | "[city] seo" 390, "web design" 50 a month, $0.09 for the Live task |
| Labs (`dataforseo_labs/*`: keyword overview, ideas, every Domain analysis call) | **No** | `dataforseo_labs/locations_and_languages` lists 94 places, none below country. A city code returns task status **40501** "Invalid Field: 'location_code'", at no charge |

So a project keeps its country in `projects.location_code`, which Labs, AI visibility and the audit go on using, and its city in `projects.city_code`. `trackedLocation()` picks where rank tracking searches from. `serp/google/locations/{iso}` is about 10 MB for the US; we keep only its City, Municipality and Borough rows in `dfs_places`, filled per country when first searched and refreshed after 30 days. A city gets its volume from Google Ads, which returns null when there are too few searches, and refuses a keyword with certain symbols, over 80 characters or over 10 words (`adsAccepts()`).

### Locations and languages appendix

| Endpoint | Cost |
|---|---|
| `serp/google/locations`, `serp/google/locations/{country_iso}`, `serp/google/languages` | Free |
| `dataforseo_labs/locations_and_languages` | Free |
| `keywords_data/google_ads/locations`, `keywords_data/google_ads/languages` | Free |
| `on_page/lighthouse/languages`, `serp/ai_mode/languages`, etc. | Free |

The fields are `location_code`, `location_name`, `location_code_parent`, `country_iso_code` and `location_type`. The lists change rarely (the Google CSV was last updated 2026-09-01).

**Caching:** fetch the lists once into Postgres and refresh them every 30 days. Also refresh right away whenever any call returns **40505** ("you are using old data").

## 3. Monthly cost estimate: one user, 5 projects

Assumptions: 500 tracked keywords in total (100 per project), desktop, US; a weekly audit of about 500 pages per project; moderate research.

| Line | Config | $/month |
|---|---|---|
| Rank tracking | 500 kw daily, Std, depth 20 | 18.00 |
| Rank tracking deep sweep | 500 kw weekly, Std, depth 100 | 13.00 |
| AI Overview capture | async AIO on the weekly sweep only | 1.30 |
| Site audits | 5 × 500 pages × 4.33/mo with `load_resources` ($0.00045) | 4.87 |
| Lighthouse | 5 key pages per project per week | 0.54 |
| Domain research | about 20 domain overviews, 20 ranked_keywords (1k rows), 20 gaps (1k rows), 20 competitor and 20 top-page lists, 10 history calls | 7.80 |
| Keyword research | 60 suggestion/related/idea calls (500 rows), 50 overviews, 10 difficulty and 10 intent batches (1k each), 10 Ads volume tasks, 100 live SERPs | 8.40 |
| Backlinks | weekly summary + 1k referring domains per project, monthly anchors, backlinks, new/lost, 10 link-gap calls | 3.20 |
| AI visibility | 100 prompts weekly through `llm_responses` Live on ChatGPT, Gemini, Claude and Perplexity (about $0.077 a prompt a week, measured over 10 days of real runs), weekly LLM-mentions target_metrics per project, monthly search_mentions (100 rows). LLM Scraper Std on ChatGPT and Gemini only would be about $4.20 | 33.20 |
| **Total (recommended)** | | **about $90** |
| Lean | daily depth 10 instead of 20 | about $81 |
| Heavy | daily depth 100 and no weekly sweep | about $149 |

A $50 monthly cap (set on Admin, Spend) covers about 2 projects at the recommended configuration. For 5 projects, raise it to about $100, or default rank tracking to daily depth 10 plus a weekly depth-100 sweep (about $81 in total), or track fewer AI prompts (about $0.33 a month each on all four AIs). If competitor share of voice beyond page 1 matters, `stop_crawl_on_match` won't do, because it stops at our domain.

## 4. Recommended cache TTLs (SEOPen client)

| Endpoint group | TTL | Why |
|---|---|---|
| `appendix/user_data` | 5 min | free; balance display |
| Locations and languages, `*/models`, lighthouse audits and versions | 30 days | static. Also refresh on 40505 |
| Labs domain: `domain_rank_overview`, `ranked_keywords`, `relevant_pages`, `competitors_domain`, `serp_competitors`, `domain_intersection`, `keywords_for_site`, `bulk_traffic_estimation` | 7 days | Labs updates domain data weekly |
| Labs `historical_rank_overview`, `historical_bulk_traffic_estimation` | 30 days | monthly points, priced at 10× |
| Labs keyword: `keyword_overview`, `keyword_suggestions`, `related_keywords`, `keyword_ideas`, `search_intent`, `bulk_keyword_difficulty` | 30 days (14 for difficulty if freshness matters) | keyword metrics update monthly |
| Google Ads `search_volume` | 30 days | monthly volumes |
| Ad-hoc `serp/.../live/advanced` (research view) | 24 h | SERPs move daily |
| `serp/google/maps/live/advanced` (Local SEO listing search) | 24 h | finding and then adding a listing is one paid call |
| Rank tracking `task_get` | no cache | each result is a dated snapshot. Store it permanently |
| Local SEO `serp/google/maps/task_post` and `task_get` | no cache | each check is a dated snapshot, kept permanently |
| On-Page crawl results | no cache. Copy into Postgres when `finished` | the provider keeps them for about 30 days (40403) |
| `on_page/instant_pages` | 24 h | |
| Lighthouse | 7 days | |
| Backlinks `summary`, `referring_domains`, `anchors`, `backlinks`, `bulk_*` | 7 days (24 h for summary if shown on the dashboard) | the index updates continuously, but weekly is enough |
| Backlinks `history`, `timeseries_*` | 7 days, append only | |
| LLM mentions | 7 days | aggregated data |
| LLM responses and scraper | no cache | tracked-prompt snapshots |
| AI keyword search volume | 30 days | |

The cache key is the endpoint path plus the canonicalised JSON body, with keys sorted and `tag` removed.

## 5. Status codes worth handling

| Code | Meaning | SEOPen action |
|---|---|---|
| 20000 / 20100 | ok / task created | store `cost`, continue |
| 40100 | not authorized | stop all calls. Show "fix API password" in Settings |
| 40104 | account not verified | stop, surface to the user |
| 40200, 40210 | payment required, insufficient funds | stop the queue, alert. The client emails `OWNER_ALERT_EMAIL` on these and on HTTP 402, once a day (`notePaymentRequired`) |
| 40201, 40208 | account paused or blocked | stop, alert |
| 40202 | per-minute rate limit | back off with jitter (60 s) |
| 40203 | dashboard cost limit exceeded | pause until the next day, alert |
| 40204 | subscription required (legacy Backlinks/LLM Mentions) | disable the module, alert |
| 40205, 40206 | duplicate-task limit per hour or day | dedupe; the cache should prevent this |
| 40207 | IP not whitelisted | alert |
| 40209 | more than 30 simultaneous requests | lower concurrency (the client semaphore should be ≤25) and retry |
| 40006, 40000 | too many tasks per POST, or more than one task for a Live call | bug: fix batching |
| 40102 | no search results | store an empty result. Don't retry |
| 40101 | internal SE server error on the task | seen on Live (see Polling, above). Rank gives up on it at once; on anything else it's a failure a person can retry |
| 40103 | task execution failed | a failure a person can retry with the same params. Nothing retries on its own, because a retry spends |
| 40106 | partial results | keep them; unreturned pages aren't charged. Where a whole call fails on it, a person can retry |
| 40401, 40403 | task not found, results expired (older than about 1 month) | drop or re-post |
| 40501–40506 | invalid field, empty or invalid body, unknown fields, 10M+ intersections, old location data | bug or validation error. Refresh locations on 40505 |
| 40501 on instant_pages | duplicate crawl host still queued | wait, then retry |
| 40601, 40602 | task handed over / in queue | not ready. Poll again later, don't resubmit |
| 50000, 50001 | internal error | retry with backoff, up to 3 times |
| 50301, 50303 | 3rd-party unavailable, update in progress | retry after a few minutes |
| 50401 | Live timeout (120 s) | retry, or switch to Standard |
| 50402 | target page too slow | retry later |

`failure-copy.ts` counts 40000 to 40299 as a problem on our side, which a customer can't fix, with no Retry. The exceptions are 40101, 40103 and 40106 above and the rate limits 40202 and 40209, which read as "try again" with a Retry button. A code not named here stays on our side: 40102 means don't retry, and 40205 and 40206 mean the cache missed something.

## 6. Gotchas

1. **The API password isn't the account password.** It's on app.dataforseo.com/api-access.
2. **No postbacks on localhost.** Poll `tasks_ready`, which allows only 20 calls per minute. One poller loop per API family is plenty.
3. **Depth is billed per 10 results.** Depth 100 costs 10× depth 10. Live max depth is 200; task_post max is 700.
4. **Keyword operators (`site:`, `intitle:`) cost 5×.** Rank tracking leaves them out when keywords are added (`withoutOperators` in `src/modules/rank/parse.ts`, using `hasSearchOperators`, which counts any `word:`), and a check prices one stored before that at 5× when it reserves (`estimateCheckCost`).
5. **Google Ads:** Live allows 12 requests per minute, and you pay per task, so always send up to 1,000 keywords per task. Ads volumes are rounded buckets, while Labs volumes are smoothed estimates. Label which source you show.
6. **Labs is Live only, one task per call,** with `target` given without `https://` or `www.`. Using `include_clickstream_data` doubles the cost. `historical_*` endpoints cost 10× the normal rate.
7. **Domain metrics are DataForSEO estimates,** updated weekly. Use GSC for real clicks; SEOpen shows both.
8. **On-Page:**
   - The default user agent is "RSiteAuditor", and Cloudflare sites may block it. Set `custom_user_agent`, or `switch_pool: true`, and `accept_language`.
   - Copy results into Postgres when the crawl finishes, because they expire.
   - CWV fields need `enable_browser_rendering`, which costs 34× base.
9. **AI Overviews** can load asynchronously. Without `load_async_ai_overview` you only get cached AIO items. The add-on is refunded when no AIO appears.
10. **LLM Mentions** is $0.10 per task, the most expensive per-call item. Cache it hard and use `*_lite` variants where they suffice. ChatGPT mentions data covers US/English only.
11. **Perplexity** `llm_responses` is Live only. Claude, ChatGPT and Gemini have Standard too, but SEOPen asks all four Live since 2026-11-02: Standard is only $0.0004 cheaper per answer and can take hours. With `llm_responses` the token cost is passed through, so the exact cost is known only from `tasks[].cost`.
12. **Check each task's `status_code`** and write `tasks[].cost`, not an estimate. `tasks_error` can be non-zero under a 20000 envelope, and a task can fail (40101 on a Live SERP, 2026-11-16) under a 20000 envelope with `tasks_error: 0`. The client saves a response only when every task is 20000 or 40102 (`cacheable` in `src/lib/dataforseo/client.ts`), and reads a saved one with a failed task as a miss.
13. **Labs sends `keyword_difficulty: 0` for keywords it hasn't scored.** The same keyword came back 0 from `keyword_suggestions` and 16 to 47 from `ranked_keywords` (2026-11-17), so SEOpen reads 0 as unknown (null) in `src/modules/keywords/transform.ts` (`knownKd`), `src/modules/domains/transform.ts`, the rank tracker's stored difficulty (`src/modules/rank/tracker.ts`) and recent lookups (`src/modules/keywords/recent.ts`). A real 0 can't be told apart. Search volume can also differ a little between Labs endpoints, since each reads its own dataset.
14. **Labs charges its per-task price for an empty answer** (no organic data, no competitors), and the ledger passes that on, so the MCP quotes for `domain_overview`, `domain_keywords`, `domain_competitors`, `domain_pages` and `keyword_ideas` warn about it. `keyword_overview` doesn't charge for keywords with no data.
15. **Set a daily spend limit in the DataForSEO dashboard** as a server-side backstop (40203) behind SEOPen's monthly cap. A 40203 emails `OWNER_ALERT_EMAIL` (`noteDailyLimit`).
16. **Prices changed on 2026-07-01** (+20% on most APIs). Cost estimates in code should read `user_data.price` rather than hard-coded constants.
