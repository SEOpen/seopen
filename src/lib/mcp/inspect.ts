import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { saveInspection } from "@/modules/indexing/inspection";
import { auditCrawls, auditPages, indexingPages } from "@/db/schema";
import type { Project } from "@/lib/projects";
import { inScope, projectScope, type WorkspaceScope } from "@/lib/workspace";
import { googleApis } from "@/modules/google/apis";
import { inspectFailureMessage, urlInProperty } from "@/modules/google/inspect-url";
import { resolveProject, ToolError } from "./data";

/**
 * Search Console's URL Inspection for one page or up to 20, as the app's Inspect form does: Google's
 * index verdict, last crawl, its canonical against the page's, robots and fetch state, and rich
 * results. Each answer joins the project's inspection history. It costs nothing, but Google allows a
 * property 2,000 inspections a day, so the MCP server counts them per key (`inspections` in
 * `limits.ts`), one for each URL sent to Google.
 */

/** The most URLs one `inspect_url` call takes. */
export const MAX_INSPECT_URLS = 20;
/** Inspections in flight at once on a batch, so 20 URLs don't reach Google in the same instant. */
const AT_ONCE = 4;

/** Counts one inspection against the key's limit: null when it may go ahead, otherwise the limit's message. */
export type InspectAllowance = () => Promise<string | null>;

type GscApi = Awaited<ReturnType<typeof googleApis>>["gsc"];
type Inspected = Awaited<ReturnType<GscApi["inspect"]>>;
type InspectableProject = Project & { gscProperty: string };

const NOTE =
  "verdict PASS means Google has the page indexed; coverage says why when it hasn't. This is Google's last look, not the page as it is now: a change made after last_crawl isn't in it. " +
  "Requesting indexing can't be done from an API; the site's owner can open inspection_link and choose Request Indexing.";

interface RichItem {
  richResultType?: string | null;
  items?: { issues?: { issueMessage?: string | null; severity?: string | null }[] | null }[] | null;
}

/** Google's rich results answer, cut to its type names and their issues. */
function richResultsOf(raw: unknown) {
  const r = raw as { verdict?: string | null; detectedItems?: RichItem[] | null } | null;
  if (!r) return null;
  return {
    verdict: r.verdict ?? null,
    types: (r.detectedItems ?? []).map((d) => ({
      type: d.richResultType ?? null,
      issues: (d.items ?? []).flatMap((i) => i.issues ?? []).map((x) => ({ message: x.issueMessage ?? null, severity: x.severity ?? null })),
    })),
  };
}

/** A path ("/pricing") becomes a URL on the project's domain; anything else must be a full http(s) URL. */
export function targetUrl(raw: string, domain: string): string {
  const input = raw.trim();
  const candidate = input.startsWith("/") ? `https://${domain}${input}` : input;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ToolError(`“${raw}” isn't a URL. Send a full address such as https://${domain}/pricing, or a path such as /pricing.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new ToolError("Send an http or https address.");
  return parsed.href;
}

async function inspectableProject(ws: WorkspaceScope, ref?: string | number): Promise<InspectableProject> {
  const project = await resolveProject(ws, ref);
  if (!project.gscProperty) throw new ToolError("This project has no Search Console property. Connect Google on its Search Console page first.");
  return { ...project, gscProperty: project.gscProperty };
}

/** The URL to inspect. Google answers one outside the property with a 403 that reads like lost access, so those never reach it. */
function checkedUrl(raw: string, project: InspectableProject): string {
  const url = targetUrl(raw, project.domain);
  if (!urlInProperty(url, project.gscProperty)) throw new ToolError(`${url} isn't in this project's Search Console property (${project.gscProperty}).`);
  return url;
}

async function searchConsole(workspaceId: number): Promise<GscApi> {
  try {
    return (await googleApis(workspaceId)).gsc;
  } catch (err) {
    console.error("[mcp.inspect_url]", err);
    throw new ToolError(inspectFailureMessage(err));
  }
}

/**
 * For a URL Google doesn't know: what SEOpen's own data says about it, from the sitemap pages and
 * the latest finished audit already saved. Reads nothing new. Null when neither says anything.
 */
async function unknownUrlHint(project: InspectableProject, url: string): Promise<string | null> {
  const scope = projectScope(project);
  const bare = url.replace(/\/+$/, "");
  const variants = [bare, `${bare}/`];
  const [inSitemap, sitemapPages, [crawl]] = await Promise.all([
    db.$count(indexingPages, and(inScope(indexingPages, scope), inArray(indexingPages.url, variants))),
    db.$count(indexingPages, inScope(indexingPages, scope)),
    db
      .select({ id: auditCrawls.id })
      .from(auditCrawls)
      .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done")))
      .orderBy(desc(auditCrawls.finishedAt))
      .limit(1),
  ]);
  const [page] = crawl
    ? await db
        .select({ statusCode: auditPages.statusCode })
        .from(auditPages)
        .where(and(eq(auditPages.workspaceId, scope.workspaceId), eq(auditPages.crawlId, crawl.id), inArray(auditPages.url, variants)))
        .limit(1)
    : [];
  if (page?.statusCode != null && page.statusCode >= 400) return `The last site audit got a ${page.statusCode} for this page, so it may not exist. Google won't index it until it loads.`;
  if (!sitemapPages || inSitemap) return null;
  const audit = crawl && !page ? ", and the last site audit didn't find it" : "";
  return `It isn't in the site's sitemap${audit}. Check that the address loads, since a 404 stays unknown to Google. If it does, add it to the sitemap and link to it from a page Google has indexed.`;
}

/** Asks Google about one URL and keeps the answer in the project's inspection history. */
async function inspectOne(gsc: GscApi, project: InspectableProject, url: string) {
  let r: Inspected;
  try {
    r = await gsc.inspect(project.gscProperty, url);
  } catch (err) {
    console.error("[mcp.inspect_url]", err);
    throw new ToolError(inspectFailureMessage(err));
  }
  await saveInspection(projectScope(project), url, r);
  const hint = (r.coverageState ?? "").toLowerCase().includes("unknown to google") ? await unknownUrlHint(project, url) : null;
  return {
    url,
    verdict: r.verdict,
    coverage: r.coverageState,
    indexing_state: r.indexingState,
    robots_txt: r.robotsTxtState,
    page_fetch: r.pageFetchState,
    last_crawl: r.lastCrawlTime,
    crawled_as: r.crawledAs,
    google_canonical: r.googleCanonical,
    page_canonical: r.userCanonical,
    canonicals_match: r.googleCanonical && r.userCanonical ? r.googleCanonical === r.userCanonical : null,
    rich_results: richResultsOf(r.richResults),
    inspection_link: r.inspectionResultLink,
    ...(hint ? { hint } : {}),
  };
}

/** One URL. It's counted against the key's limit after the address is checked, so a mistyped one costs nothing. */
export async function inspectUrlData(ws: WorkspaceScope, args: { project?: string | number; url: string }, allow: InspectAllowance = async () => null) {
  const project = await inspectableProject(ws, args.project);
  const url = checkedUrl(args.url, project);
  const refused = await allow();
  if (refused) throw new ToolError(refused);
  const gsc = await searchConsole(project.workspaceId);
  return { project: { id: project.id, domain: project.domain }, ...(await inspectOne(gsc, project, url)), note: NOTE };
}

/**
 * Several URLs, one result each in the order given (a repeat is inspected once). An address that
 * isn't a URL or isn't in the property, or one Google wouldn't inspect, gets an `error` in its
 * place and the rest go on. Each URL sent to Google is counted against the key's limit, in order;
 * once the limit is reached, the rest are listed in `not_inspected` with the limit's message.
 */
export async function inspectUrlsData(ws: WorkspaceScope, args: { project?: string | number; urls: string[] }, allow: InspectAllowance = async () => null) {
  const project = await inspectableProject(ws, args.project);
  const seen = new Set<string>();
  const items: ({ url: string; error: null } | { url: string; error: string })[] = [];
  for (const input of args.urls) {
    try {
      const url = checkedUrl(input, project);
      if (seen.has(url)) continue;
      seen.add(url);
      items.push({ url, error: null });
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      items.push({ url: input, error: e.message });
    }
  }

  // Counted in order before anything is sent, so the URLs a limit refuses are always the last ones.
  const allowed: number[] = [];
  let refusal: string | null = null;
  for (const [i, item] of items.entries()) {
    if (item.error) continue;
    refusal = await allow();
    if (refusal) break;
    allowed.push(i);
  }
  if (!allowed.length && refusal) throw new ToolError(refusal);

  type Result = Awaited<ReturnType<typeof inspectOne>> | { url: string; error: string };
  const results: (Result | null)[] = items.map((item) => (item.error ? { url: item.url, error: item.error } : null));
  if (allowed.length) {
    const gsc = await searchConsole(project.workspaceId);
    const queue = [...allowed];
    const worker = async () => {
      for (let i = queue.shift(); i != null; i = queue.shift()) {
        const url = items[i].url;
        try {
          results[i] = await inspectOne(gsc, project, url);
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          results[i] = { url, error: e.message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
  }

  const notInspected = refusal ? items.filter((item, i) => !item.error && results[i] == null).map((item) => item.url) : [];
  const done = results.filter((r): r is Result => r != null);
  return {
    project: { id: project.id, domain: project.domain },
    inspected: done.filter((r) => !("error" in r)).length,
    results: done,
    ...(notInspected.length
      ? { not_inspected: notInspected, message: `Inspected ${allowed.length} of ${allowed.length + notInspected.length}, then reached the limit. ${refusal} Not inspected: ${notInspected.join(", ")}.` }
      : {}),
    note: NOTE,
  };
}
