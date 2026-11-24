import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { indexingPages, indexingSettings, projects } from "@/db/schema";
import { OpError, plural, type Actor, type OpOptions } from "@/lib/ops";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { checkKeyFile } from "./indexnow";
import { queueIndexingSync } from "./jobs";
import { hostOf, indexNowBatch, keyFileUrl } from "./state";
import { ensureSettings, keyHost, submitChanged, verifyKey } from "./sync";

async function projectOf(scope: ProjectScope) {
  const [p] = await db
    .select({ domain: projects.domain })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!p) throw new OpError("That project doesn't exist.");
  return p;
}

export interface IndexNowState {
  enabled: boolean;
  verified: boolean;
  keyFile: string;
  changed: boolean;
  message: string;
}

/**
 * Turns automatic IndexNow submission on or off: the Indexing tab's switch. Turning it on first
 * looks for the key file on the site and refuses until it's there, since IndexNow refuses pages
 * without it. From then on the worker sends new and changed sitemap pages every four hours.
 */
export async function setIndexNowOp(scope: ProjectScope, _actor: Actor, input: { enabled: boolean }, opts: OpOptions = {}): Promise<IndexNowState> {
  const { domain } = await projectOf(scope);
  const settings = await ensureSettings(scope);
  const host = settings.indexnowHost ?? (await keyHost(scope, domain));
  const keyFile = keyFileUrl(host, settings.indexnowKey);
  const state = (verified: boolean, enabled: boolean, changed: boolean, message: string): IndexNowState => ({ enabled, verified, keyFile, changed, message });

  if (!input.enabled) {
    if (!settings.indexnowEnabled) return state(!!settings.indexnowVerifiedAt, false, false, "IndexNow is already off.");
    if (opts.dryRun) return state(!!settings.indexnowVerifiedAt, true, true, "Would stop sending pages to IndexNow. Pages already sent stay sent.");
    await db.update(indexingSettings).set({ indexnowEnabled: false, updatedAt: new Date() }).where(inScope(indexingSettings, scope));
    return state(!!settings.indexnowVerifiedAt, false, true, "Stopped sending pages to IndexNow.");
  }

  if (settings.indexnowEnabled && settings.indexnowVerifiedAt) return state(true, true, false, "IndexNow is already on.");
  // A dry run looks for the file without recording what it found.
  const check = opts.dryRun ? await checkKeyFile(host, settings.indexnowKey).then((r) => (r.ok ? { ok: true, host: r.host, error: null } : { ok: false, host, error: r.error })) : await verifyKey(scope, domain, settings);
  if (!check.ok) throw new OpError(`IndexNow stays off until the key file is on the site. ${check.error}`);
  const file = keyFileUrl(check.host, settings.indexnowKey);
  if (opts.dryRun) return { enabled: false, verified: true, keyFile: file, changed: true, message: `Found ${file}. Would send the sitemap's pages to IndexNow now, then new and changed ones every four hours.` };
  await db.update(indexingSettings).set({ indexnowEnabled: true, updatedAt: new Date() }).where(inScope(indexingSettings, scope));
  await queueIndexingSync(scope);
  return { enabled: true, verified: true, keyFile: file, changed: true, message: `Found ${file}. The sitemap's pages go to IndexNow within a few minutes, then new and changed ones every four hours.` };
}

/** Looks for the key file now: the Indexing tab's Check the file button. Changes only what was found. */
export async function checkKeyFileOp(scope: ProjectScope): Promise<{ ok: boolean; keyFile: string; message: string }> {
  const { domain } = await projectOf(scope);
  const settings = await ensureSettings(scope);
  const r = await verifyKey(scope, domain, settings);
  const keyFile = keyFileUrl(r.host, settings.indexnowKey);
  return { ok: r.ok, keyFile, message: r.ok ? `Found ${keyFile}.` : (r.error ?? "The key file wasn't found.") };
}

export const MAX_SUBMIT_URLS = 1000;

/**
 * Sends pages to IndexNow now, whether or not the automatic switch is on: the MCP submit_indexnow
 * tool, for an agent that just shipped a change. `urls` names the pages (on the key's host); left
 * out, it sends every sitemap page that's new or changed since it was last sent.
 */
export async function submitIndexNowOp(scope: ProjectScope, _actor: Actor, input: { urls?: string[] }, opts: OpOptions = {}) {
  const { domain } = await projectOf(scope);
  let settings = await ensureSettings(scope);
  if (input.urls && input.urls.length > MAX_SUBMIT_URLS) throw new OpError(`Send at most ${MAX_SUBMIT_URLS} pages at once.`);
  if (!settings.indexnowVerifiedAt) {
    const host = await keyHost(scope, domain);
    const r = opts.dryRun ? await checkKeyFile(host, settings.indexnowKey) : await verifyKey(scope, domain, settings);
    if (!r.ok) throw new OpError(`IndexNow needs its key file on the site first. Upload a file named ${settings.indexnowKey}.txt containing just ${settings.indexnowKey} to the site's root. ${r.error}`);
    settings = opts.dryRun ? { ...settings, indexnowHost: host } : await ensureSettings(scope);
  }
  if (opts.dryRun) {
    // As the real send does, named pages count only when they're on the key's host.
    const named = input.urls ? [...new Set(input.urls)] : null;
    const onHost = named?.filter((u) => hostOf(u) === settings.indexnowHost) ?? [];
    const offHost = named?.filter((u) => hostOf(u) !== settings.indexnowHost) ?? [];
    if (named && !onHost.length) return { sent: 0, wouldSend: 0, ok: true, status: null, message: `None of those pages are on ${settings.indexnowHost}, the site the key is on.` };
    // Left out, the count is the sitemap pages the real send would pick, as get_indexing's waiting_to_send.
    const pending = named ? 0 : indexNowBatch(await db.select({ url: indexingPages.url, lastmod: indexingPages.lastmod, submittedAt: indexingPages.submittedAt, submittedLastmod: indexingPages.submittedLastmod }).from(indexingPages).where(inScope(indexingPages, scope)), settings.indexnowHost ?? "").length;
    if (!named && !pending) return { sent: 0, wouldSend: 0, ok: true, status: null, message: "Nothing new or changed in the sitemap to send." };
    const what = named ? plural(onHost.length, "named page") : `${plural(pending, "sitemap page")} new or changed since last sent`;
    const left = offHost.length ? ` ${plural(offHost.length, "page")} not on ${settings.indexnowHost} would be left out: ${offHost.join(", ")}.` : "";
    return { sent: 0, wouldSend: named ? onHost.length : pending, ok: true, status: null, message: `Would send ${what} to IndexNow (Bing, Yandex, Seznam, Naver), for ${settings.indexnowHost}.${left}` };
  }
  return submitChanged(scope, settings, input.urls);
}

/**
 * Marks pages as requested in Search Console, or clears the mark: the Indexing tab's Mark requested
 * and Undo. SEOpen can't press Request Indexing itself; this records that the owner did, so the
 * page moves to Requested and is inspected again the next day.
 */
export async function markRequestedOp(scope: ProjectScope, _actor: Actor, input: { urls: string[]; requested: boolean }, opts: OpOptions = {}) {
  if (!input.urls.length) throw new OpError("Name at least one page.");
  const rows = await db
    .select({ url: indexingPages.url })
    .from(indexingPages)
    .where(and(inScope(indexingPages, scope), inArray(indexingPages.url, input.urls)));
  if (!rows.length) throw new OpError("None of those pages are in the project's sitemap list.");
  const urls = rows.map((r) => r.url);
  if (!opts.dryRun) {
    await db
      .update(indexingPages)
      .set({ requestedAt: input.requested ? new Date() : null })
      .where(and(inScope(indexingPages, scope), inArray(indexingPages.url, urls)));
  }
  const what = plural(urls.length, "page");
  return { urls, message: input.requested ? `${opts.dryRun ? "Would mark" : "Marked"} ${what} requested.` : `${opts.dryRun ? "Would clear" : "Cleared"} the request on ${what}.` };
}
