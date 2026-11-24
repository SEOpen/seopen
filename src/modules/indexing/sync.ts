import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { indexingPages, indexingSettings, type projects } from "@/db/schema";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { googleApis } from "@/modules/google/apis";
import { GoogleAccessError } from "@/modules/google/auth";
import { urlInProperty } from "@/modules/google/inspect-url";
import { GoogleNotConnectedError, GoogleQuotaError } from "@/modules/google/types";
import { checkKeyFile, submitToIndexNow } from "./indexnow";
import { readSitemap } from "./sitemap";
import { hostOf, INSPECTIONS_PER_DAY, INSPECTIONS_PER_RUN, indexNowBatch, mainHost, newIndexNowKey, nextIndexedAt, pickForInspection } from "./state";

type Project = Pick<typeof projects.$inferSelect, "id" | "workspaceId" | "domain" | "gscProperty">;
export type IndexingSettings = typeof indexingSettings.$inferSelect;

const CHUNK = 500;
const CONCURRENCY = 3;
/** Inspection failures in a row that end a run: something is wrong beyond one page. */
const MAX_FAILURES = 5;

/** The project's settings row, made with a fresh IndexNow key the first time. */
export async function ensureSettings(scope: ProjectScope): Promise<IndexingSettings> {
  await db
    .insert(indexingSettings)
    .values({ ...scope, indexnowKey: newIndexNowKey() })
    .onConflictDoNothing({ target: indexingSettings.projectId });
  const [row] = await db.select().from(indexingSettings).where(inScope(indexingSettings, scope));
  return row;
}

async function updateSettings(scope: ProjectScope, set: Partial<IndexingSettings>) {
  await db
    .update(indexingSettings)
    .set({ ...set, updatedAt: new Date() })
    .where(inScope(indexingSettings, scope));
}

/** Reads the sitemap into indexing_pages: new pages added, lastmods updated, pages gone from it deleted. */
export async function refreshPages(scope: ProjectScope, domain: string): Promise<{ ok: boolean; pages: number; added: number; removed: number; error?: string }> {
  const read = await readSitemap(domain);
  if (!read.ok) {
    await updateSettings(scope, { sitemapUrl: read.sitemapUrl, sitemapError: read.error });
    return { ok: false, pages: 0, added: 0, removed: 0, error: read.error };
  }
  const existing = new Set((await db.select({ url: indexingPages.url }).from(indexingPages).where(inScope(indexingPages, scope))).map((r) => r.url));
  const seen = new Set(read.pages.map((p) => p.loc));
  for (let i = 0; i < read.pages.length; i += CHUNK) {
    await db
      .insert(indexingPages)
      .values(read.pages.slice(i, i + CHUNK).map((p) => ({ ...scope, url: p.loc, lastmod: p.lastmod })))
      .onConflictDoUpdate({ target: [indexingPages.projectId, indexingPages.url], set: { lastmod: sql`excluded.lastmod` } });
  }
  const gone = [...existing].filter((u) => !seen.has(u));
  for (let i = 0; i < gone.length; i += CHUNK) {
    await db.delete(indexingPages).where(and(inScope(indexingPages, scope), inArray(indexingPages.url, gone.slice(i, i + CHUNK))));
  }
  await updateSettings(scope, { sitemapUrl: read.sitemapUrl, sitemapReadAt: new Date(), sitemapError: null, sitemapPages: read.total });
  return { ok: true, pages: read.pages.length, added: read.pages.filter((p) => !existing.has(p.loc)).length, removed: gone.length };
}

/** The host the key file belongs on: where most sitemap pages are, else the project's domain. */
export async function keyHost(scope: ProjectScope, domain: string): Promise<string> {
  const rows = await db.select({ url: indexingPages.url }).from(indexingPages).where(inScope(indexingPages, scope)).limit(1000);
  return mainHost(rows.map((r) => r.url)) ?? domain.toLowerCase();
}

/** Looks for the key file on the site and records what it found. */
export async function verifyKey(scope: ProjectScope, domain: string, settings: IndexingSettings): Promise<{ ok: boolean; host: string; error: string | null }> {
  const host = await keyHost(scope, domain);
  const r = await checkKeyFile(host, settings.indexnowKey);
  const now = new Date();
  await updateSettings(scope, r.ok ? { indexnowHost: host, indexnowVerifiedAt: now, indexnowCheckedAt: now, indexnowError: null } : { indexnowVerifiedAt: null, indexnowCheckedAt: now, indexnowError: r.error });
  return { ok: r.ok, host, error: r.ok ? null : r.error };
}

export interface SubmitSummary {
  sent: number;
  ok: boolean;
  status: number | null;
  message: string;
}

/**
 * Sends the given pages, or else every page that's new or changed since it was last sent, to
 * IndexNow. Needs a verified key; callers check the owner switched it on (or confirmed a one-off).
 */
export async function submitChanged(scope: ProjectScope, settings: IndexingSettings, only?: string[]): Promise<SubmitSummary> {
  const host = settings.indexnowHost;
  if (!settings.indexnowVerifiedAt || !host) return { sent: 0, ok: false, status: null, message: "The IndexNow key file hasn't been found on the site yet." };
  const rows = await db
    .select({ url: indexingPages.url, lastmod: indexingPages.lastmod, submittedAt: indexingPages.submittedAt, submittedLastmod: indexingPages.submittedLastmod })
    .from(indexingPages)
    .where(and(inScope(indexingPages, scope), only ? inArray(indexingPages.url, only) : undefined));
  // Named pages go whether or not they're in the sitemap, as long as they're on the key's host.
  const known = new Map(rows.map((r) => [r.url, r]));
  const batch = only ? [...new Set(only)].filter((u) => hostOf(u) === host).map((url) => ({ url, lastmod: known.get(url)?.lastmod ?? null })) : indexNowBatch(rows, host);
  if (!batch.length) return { sent: 0, ok: true, status: null, message: only ? `None of those pages are on ${host}, the site the key is on.` : "Nothing new or changed to send." };

  const r = await submitToIndexNow(host, settings.indexnowKey, batch.map((b) => b.url));
  const now = new Date();
  if (r.ok) {
    // Each page records the lastmod it went with, so it goes again only when that changes.
    for (const b of batch) {
      await db
        .update(indexingPages)
        .set({ submittedAt: now, submittedLastmod: b.lastmod })
        .where(and(inScope(indexingPages, scope), eq(indexingPages.url, b.url)));
    }
  }
  await updateSettings(scope, {
    lastSubmitAt: now,
    lastSubmitCount: r.ok ? batch.length : 0,
    lastSubmitStatus: r.status,
    indexnowError: r.ok ? null : r.message,
    ...(r.keyRejected ? { indexnowVerifiedAt: null } : {}),
  });
  return { sent: r.ok ? batch.length : 0, ok: r.ok, status: r.status, message: r.message };
}

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Inspects the next pages due, within the day's share of the property's quota. */
export async function inspectDue(scope: ProjectScope, property: string, now = new Date()): Promise<{ inspected: number; stopped: string | null }> {
  const [{ today }] = await db
    .select({ today: sql<number>`count(*)::int` })
    .from(indexingPages)
    .where(and(inScope(indexingPages, scope), gte(indexingPages.inspectedAt, startOfUtcDay(now))));
  const limit = Math.min(INSPECTIONS_PER_RUN, INSPECTIONS_PER_DAY - today);
  if (limit <= 0) return { inspected: 0, stopped: null };

  const rows = await db.select().from(indexingPages).where(inScope(indexingPages, scope));
  const due = pickForInspection(
    rows.filter((r) => urlInProperty(r.url, property)),
    now,
    limit,
  );
  if (!due.length) return { inspected: 0, stopped: null };

  const api = await googleApis(scope.workspaceId);
  let inspected = 0;
  let failures = 0;
  let stopped: string | null = null;
  for (let i = 0; i < due.length && !stopped; i += CONCURRENCY) {
    await Promise.all(
      due.slice(i, i + CONCURRENCY).map(async (page) => {
        if (stopped) return;
        const at = new Date();
        try {
          const r = await api.gsc.inspect(property, page.url);
          failures = 0;
          inspected++;
          await db
            .update(indexingPages)
            .set({
              inspectedAt: at,
              verdict: r.verdict,
              coverageState: r.coverageState,
              robotsTxtState: r.robotsTxtState,
              indexingState: r.indexingState,
              pageFetchState: r.pageFetchState,
              lastCrawlTime: r.lastCrawlTime ? new Date(r.lastCrawlTime) : null,
              googleCanonical: r.googleCanonical,
              inspectionLink: r.inspectionResultLink,
              indexedAt: nextIndexedAt(page, r.verdict, at),
            })
            .where(and(inScope(indexingPages, scope), eq(indexingPages.url, page.url)));
        } catch (err) {
          if (err instanceof GoogleQuotaError) stopped = "Search Console's inspection quota for this property is used up for today. The rest wait for tomorrow.";
          else if (err instanceof GoogleNotConnectedError) stopped = err.message;
          else if (err instanceof GoogleAccessError) stopped = "Google refused access to this property. Check the connected account can still open it in Search Console.";
          else {
            console.error("[indexing.inspect]", page.url, err);
            // The page moves to the back of the queue; Google may answer next time.
            await db
              .update(indexingPages)
              .set({ inspectedAt: at, verdict: "ERROR" })
              .where(and(inScope(indexingPages, scope), eq(indexingPages.url, page.url)));
            if (++failures >= MAX_FAILURES) stopped = "Google failed several inspections in a row. The next run tries again.";
          }
        }
      }),
    );
  }
  await updateSettings(scope, { inspectedAt: new Date(), inspectError: stopped });
  return { inspected, stopped };
}

export interface SyncSummary {
  pages: number;
  added: number;
  removed: number;
  sitemapError?: string;
  submitted?: SubmitSummary;
  inspected?: number;
  inspectStopped?: string | null;
}

/** One run for one project: read the sitemap, send changes to IndexNow if it's on, inspect what's due. */
export async function syncIndexing(scope: ProjectScope, project: Project): Promise<SyncSummary> {
  await ensureSettings(scope);
  const pages = await refreshPages(scope, project.domain);
  const out: SyncSummary = { pages: pages.pages, added: pages.added, removed: pages.removed, ...(pages.error ? { sitemapError: pages.error } : {}) };

  const settings = await ensureSettings(scope);
  if (settings.indexnowEnabled) {
    // The key is looked for again until it's found, and after IndexNow refuses it.
    const current = settings.indexnowVerifiedAt ? settings : await verifyKey(scope, project.domain, settings).then(() => ensureSettings(scope));
    if (current.indexnowVerifiedAt) out.submitted = await submitChanged(scope, current);
  }

  if (project.gscProperty) {
    try {
      const r = await inspectDue(scope, project.gscProperty);
      out.inspected = r.inspected;
      out.inspectStopped = r.stopped;
    } catch (err) {
      // No Google account: the list waits until one is connected; IndexNow carries on.
      if (!(err instanceof GoogleNotConnectedError || err instanceof GoogleAccessError)) throw err;
      await updateSettings(scope, { inspectError: err.message });
      out.inspectStopped = err.message;
    }
  }
  return out;
}
