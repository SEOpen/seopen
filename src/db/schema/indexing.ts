import { boolean, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";

/**
 * Getting a project's pages indexed (src/modules/indexing). Every project on every
 * plan: the worker reads the site's sitemap, asks Search Console's URL Inspection which pages Google
 * hasn't indexed (read-only, free, within the property's 2,000 a day), and, once the owner hosts a
 * key file and switches it on, sends new and changed pages to IndexNow (Bing, Yandex, Seznam, Naver).
 */

/** A project's indexing settings and the state of its last sitemap read and IndexNow submission. One row per project. */
export const indexingSettings = pgTable(
  "indexing_settings",
  {
    workspaceId: workspaceId(),
    projectId: integer().primaryKey(),
    /** The IndexNow key, 32 hex characters, made when the row is. The site hosts it at `https://<host>/<key>.txt`. Public by design. */
    indexnowKey: text().notNull(),
    /** The owner switched automatic IndexNow submission on. Off until they do; it needs a verified key. */
    indexnowEnabled: boolean().notNull().default(false),
    /** The host the key file was found on, e.g. "www.example.com". IndexNow only takes URLs on this host. */
    indexnowHost: text(),
    /** Last time the key file was found with the key in it. Null when it never was, or the last check failed. */
    indexnowVerifiedAt: timestamp({ withTimezone: true }),
    indexnowCheckedAt: timestamp({ withTimezone: true }),
    /** Why the last key check or submission failed, in words. Null after a success. */
    indexnowError: text(),
    lastSubmitAt: timestamp({ withTimezone: true }),
    lastSubmitCount: integer(),
    /** IndexNow's HTTP status for the last submission: 200 or 202 is accepted. */
    lastSubmitStatus: integer(),
    /** The sitemap the last read started from. */
    sitemapUrl: text(),
    sitemapReadAt: timestamp({ withTimezone: true }),
    /** Why the last sitemap read failed. Null after a success. */
    sitemapError: text(),
    /** Pages the last good read found, before the cap. */
    sitemapPages: integer(),
    /** Last time the worker inspected pages, and what stopped it (quota, reauth) if anything. */
    inspectedAt: timestamp({ withTimezone: true }),
    inspectError: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [...projectScoped("indexing_settings", t)],
);

/**
 * One page from the project's sitemap: Google's last answer for it and what was last sent to
 * IndexNow. Rows for pages that leave the sitemap are deleted on the next good read. Kept apart from
 * gsc_url_inspections, which is the capped history of inspections people asked for.
 */
export const indexingPages = pgTable(
  "indexing_pages",
  {
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    url: text().notNull(),
    /** The sitemap's `<lastmod>`, as written. Null when it has none. */
    lastmod: text(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    inspectedAt: timestamp({ withTimezone: true }),
    /** Google's verdict: PASS means indexed. */
    verdict: text(),
    /** Google's coverage words, e.g. "Crawled - currently not indexed". */
    coverageState: text(),
    robotsTxtState: text(),
    indexingState: text(),
    pageFetchState: text(),
    lastCrawlTime: timestamp({ withTimezone: true }),
    googleCanonical: text(),
    /** Search Console's page for this URL, where the owner presses Request Indexing. */
    inspectionLink: text(),
    /** When the owner marked that they pressed Request Indexing in Search Console. Null when they haven't. */
    requestedAt: timestamp({ withTimezone: true }),
    /** When an inspection first found the page indexed after one that didn't. Null otherwise. */
    indexedAt: timestamp({ withTimezone: true }),
    /** The lastmod sent to IndexNow last, so a page goes again only when it changes. */
    submittedLastmod: text(),
    submittedAt: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.url] }), index().on(t.projectId, t.inspectedAt), ...projectScoped("indexing_pages", t)],
);
