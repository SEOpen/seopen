import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { MAX_KEYWORDS_PER_ADD, startRankCheckOp, trackKeywordsOp } from "@/modules/rank/ops";
import { setAlertRuleOp } from "@/modules/alerts/ops";
import { MAX_SUBMIT_URLS, submitIndexNowOp } from "@/modules/indexing/ops";
import { ALERT_RULES } from "@/modules/alerts/rules";
import { ACTION_KINDS, ACTION_STATUSES } from "@/modules/ai/action-list";
import { MAX_ACTION_CHANGES, setActionStatusOp } from "@/modules/ai/action-ops";
import { addPromptsOp, startAiRunOp } from "@/modules/ai/ops";
import { PLATFORM_KEYS } from "@/modules/ai/platforms";
import { startCrawlOp } from "@/modules/audit/ops";
import { MAX_KEYWORDS_PER_SAVE, MAX_LIST_NAME, saveKeywordsOp } from "@/modules/keywords/ops";
import { createBriefOp } from "@/modules/content-briefs/ops";
import { MAX_MERGED, OPTION_RANGE } from "@/modules/content-briefs/templates";
import { PAGE_TYPES } from "@/modules/content-briefs/types";
import { MOVE_SIZES, saveTeardownOp, TEARDOWN_LIMITS as TL } from "@/modules/domains/teardowns";
import { MAX_PAGES_LIMIT } from "@/modules/audit/crawl";
import { GRID_SIZES, RADII_MILES } from "@/modules/local/grid";
import { addBusinessOp, addLocalKeywordsOp, findListingsOp, startLocalCheckOp, type LocalPrice } from "@/modules/local/ops";
import { MAX_KEYWORDS_PER_BUSINESS } from "@/modules/local/parse";
import { getBusiness } from "@/modules/local/tracker";
import { normalizeDomain } from "@/lib/projects";
import { addCompetitorsOp, createProjectOp, findMarket, projectDomain } from "@/lib/ops/projects";
import { LOCATIONS } from "@/lib/dataforseo/locations";
import { projectScope } from "@/lib/workspace";
import { plural, type Actor } from "@/lib/ops";
import { rules } from "@/plan-policy/rules";
import { connectionName, resolveLiveProject, ToolError } from "./data";
import { canResearch, type Principal } from "./keys";
import { consumeLimit } from "./limits";

/**
 * Tools that change the workspace, offered only to keys with the `write` scope. Each calls the same operation as the app's button (`src/lib/ops`), so plan limits,
 * read-only projects and spend gates hold here too. Without `confirm: true` a tool changes nothing
 * and answers with what it would do; research steps (Local SEO, and an AI run started now) instead
 * need `max_credits` at or above their quoted price, and a key with the `research` scope too, the
 * same as the research lookups: making changes never brings spending with it. No tool deletes anything. Each change counts against the key's hourly
 * limit (`limits.ts`).
 */

/** Adds or starts something: not read-only, not idempotent, and destructive only where a tool below overwrites something or sends it out. */
const ADDS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Starts paid work at DataForSEO. */
const RUNS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const project = z.union([z.string(), z.number().int()]).optional().describe("Project id or domain, from list_projects. Optional when the workspace has one project.");
const confirm = z
  .boolean()
  .optional()
  .describe("Left out or false: change nothing and describe what would happen. True: make the change. Show the user the description and ask before sending true.");
const maxCredits = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(`The most ${rules.creditUnit} this call may spend. Left out or below the quoted price, nothing runs and the price comes back. Setting it is the user's approval of that price.`);

type Run = (tool: string, body: () => Promise<object>) => Promise<CallToolResult>;

/** What start_site_audit says about its price: the plan covers it, so there's no credit quote to show. Without plans, it isn't research. */
export const AUDIT_COST = rules.hasPlans
  ? "Covered by the plan: a site audit uses no research credits. The plan sets the pages per audit."
  : "A site audit isn't a research lookup, so it needs no max_credits. It counts against the workspace's monthly DataForSEO cap.";

/** What start_rank_check says about its price: like an audit, the plan covers it. */
export const RANK_CHECK_COST = rules.hasPlans
  ? "Covered by the plan: a rank check uses no research credits. Tracked keywords count against the plan's keyword limit."
  : "A rank check isn't a research lookup, so it needs no max_credits. It counts against the workspace's monthly DataForSEO cap.";

/** Added to a plan-covered cost line when the workspace also sees dollars. */
const OWN_COST = rules.hasPlans
  ? " The dollar figure is SEOpen's own DataForSEO cost, which only the owner's workspace sees. It uses no credits."
  : " The dollar figure is what it costs at DataForSEO.";

/** A check that isn't research, in a tool's description: "A check <COVERED> (`credits: 0`)". */
const COVERED = rules.hasPlans ? "is covered by the plan and uses no research credits" : "isn't a research lookup, so it needs no max_credits";

/** What a research step does, after "Weekly checks": "spend research credits" on a hosted plan, "spend on DataForSEO" without plans. */
const SPEND = rules.hasPlans ? `spend ${rules.researchNoun}` : "spend on DataForSEO";

/** A research step's price, to start a tool's sentence. */
const COSTS = rules.hasPlans ? `Costs ${rules.researchNoun}` : "Costs money at DataForSEO";

/** Why a key without the `research` scope can't go on, after "and". */
const CANT_SPEND = rules.hasPlans ? "this key can't spend them" : "this key can't run research lookups";

/** What track_keywords says a keyword takes, after "from the next scheduled run,". */
const KEYWORD_UNITS = rules.hasPlans
  ? "and each keyword counts against the plan's keyword limit in units, one per 10 results checked a day (2 at the default depth of 20). The answer gives the units the add takes and, when the plan has a limit, `keyword_units_left`."
  : "and each keyword takes units, one per 10 results checked a day (2 at the default depth of 20), which DataForSEO charges for. The answer gives the units the add takes.";

/** What `credits_spent` counts, capitalised to start a description. */
const CREDIT_UNIT = rules.creditUnit.charAt(0).toUpperCase() + rules.creditUnit.slice(1);

/**
 * A dry run's answer: what would happen, and how to go ahead. `dry_run` leads, so counts named in
 * the past tense (added, changed) read as what would happen.
 */
function preview(result: { message: string }, how = "Call again with confirm: true to make this change.") {
  return { dry_run: true, ...result, needs_confirmation: true, next: how };
}

/** Dollars rounded up to the cent, so a float like 0.5147999999999999 reads 0.52. */
function cents(usd: number) {
  return Math.ceil(Math.round(usd * 10000) / 100) / 100;
}

/** `estimate_usd` when the workspace sees dollar costs, nothing otherwise. */
function usdOf(usd: number | null) {
  return usd != null ? { estimate_usd: cents(usd) } : {};
}

/** What a key without the `research` scope is told when a step would spend (as research-tools.ts says it). */
export const NO_RESEARCH = rules.hasPlans
  ? `This key can't spend ${rules.researchNoun}. A key made with “${rules.researchScope}” on SEOpen's MCP page, or an app allowed to spend them, can run this.`
  : `This key can't run research lookups. A key made with “${rules.researchScope}” on SEOpen's MCP page, or an app allowed to run them, can run this.`;

/** A research step's answer when it wasn't allowed to spend. `allowed` is whether this key may spend at all. */
function priced<T extends { message: string; price: Pick<LocalPrice, "credits"> }>(result: T, allowed: boolean) {
  return {
    dry_run: true,
    ...result,
    needs_approval: true,
    next: allowed ? `Ask the user, then call again with max_credits of at least ${result.price.credits}.` : NO_RESEARCH,
  };
}

export function registerWriteTools(server: McpServer, principal: Principal, run: Run) {
  const ws = { workspaceId: principal.workspaceId };
  const actor: Actor = { userId: principal.userId, source: "mcp" };
  const scopeOf = async (ref?: string | number) => projectScope(await resolveLiveProject(ws, ref));
  /** Research credits are the `research` scope's, whatever `write` allows. */
  const spends = canResearch(principal);
  /** Whether a paid step may run now: the key may spend, and `max_credits` covers the price. */
  const covered = (max: number | undefined, credits: number) => spends && (max ?? 0) >= credits;
  const refuseSpend = () => {
    throw new ToolError(NO_RESEARCH);
  };
  /** Counts a change (or a paid lookup) against the key's hourly limit, refusing past it. */
  const counted = async () => {
    const limit = await consumeLimit(principal, "changes");
    if (!limit.ok) throw new ToolError(limit.message);
  };

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: `Adds a site to the workspace${rules.hasPlans ? ", within the plan's project limit" : ""}. \`market\` is a country (${LOCATIONS.map((l) => l.name).join(", ")}) or its location code; it sets where rankings and research are measured. Left out, the market is the United States and the language the market's own.`,
      inputSchema: z.object({
        domain: z.string().min(3).max(253).describe("The site's domain, such as example.com."),
        name: z.string().min(1).max(80).optional().describe("A display name (default: the domain)."),
        market: z.union([z.string(), z.number().int()]).optional(),
        language: z.string().min(2).max(8).optional().describe("Language code, such as en (default: the market's)."),
        competitors: z.array(z.string().max(253)).max(20).optional().describe("Competitor domains."),
        confirm,
      }),
      annotations: ADDS,
    },
    (args) =>
      run("create_project", async () => {
        if (args.confirm) await counted();
        const market = findMarket(args.market ?? "United States");
        if (!market) throw new ToolError(`Unknown market “${args.market}”. Use one of: ${LOCATIONS.map((l) => l.name).join(", ")}.`);
        const domain = normalizeDomain(args.domain);
        const [dupe] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.workspaceId, ws.workspaceId), eq(projects.domain, domain), eq(projects.archived, false)));
        if (dupe) throw new ToolError(`${domain} is already project ${dupe.id} in this workspace.`);
        const input = { name: args.name ?? domain, domain, locationCode: market.code, languageCode: args.language ?? market.languageCode, competitors: args.competitors ?? [] };
        const res = await createProjectOp(ws, actor, input, { dryRun: !args.confirm });
        const out = { project_id: res.projectId, domain: res.domain, market: market.name, language: input.languageCode, competitors: res.competitors, message: res.message };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "add_competitors",
    {
      title: "Add competitors",
      description: "Adds competitor domains to a project. They show in rank tracking and AI visibility share of voice. Domains already there are left alone.",
      inputSchema: z.object({ project, domains: z.array(z.string().max(253)).min(1).max(20), confirm }),
      annotations: ADDS,
    },
    (args) =>
      run("add_competitors", async () => {
        if (args.confirm) await counted();
        const res = await addCompetitorsOp(await scopeOf(args.project), args.domains, { dryRun: !args.confirm });
        // The op drops anything that isn't a domain; say so rather than leave the caller guessing.
        const notDomains = args.domains.filter((d) => !d.split(/[\s,]+/).some((part) => projectDomain(part)));
        const out = {
          added: res.added,
          already: res.already,
          ...(notDomains.length ? { not_domains: notDomains } : {}),
          message: notDomains.length ? `${res.message} Left out ${notDomains.length} that ${notDomains.length === 1 ? "isn't a domain" : "aren't domains"}: ${notDomains.join(", ")}.` : res.message,
        };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "track_keywords",
    {
      title: "Track keywords",
      description: `Adds keywords to rank tracking: Google positions are checked every day from the next scheduled run, ${KEYWORD_UNITS} Keywords already tracked get the tags merged, the same keyword in other case or spacing is counted once and listed in \`duplicates\`, and keywords with search operators such as site: are left out. At most ${MAX_KEYWORDS_PER_ADD} new keywords per call.`,
      inputSchema: z.object({
        project,
        keywords: z.array(z.string().max(200)).min(1).max(MAX_KEYWORDS_PER_ADD),
        tags: z.array(z.string().max(50)).max(20).optional().describe("Tags to group keywords, such as a topic or page."),
        device: z.enum(["desktop", "mobile"]).optional().describe("Default desktop."),
        confirm,
      }),
      annotations: ADDS,
    },
    (args) =>
      run("track_keywords", async () => {
        if (args.confirm) await counted();
        const tags = [...new Set((args.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
        const res = await trackKeywordsOp(await scopeOf(args.project), actor, { keywords: args.keywords, tags, device: args.device }, { dryRun: !args.confirm });
        const out = {
          added: res.added,
          already_tracked: res.already,
          over_limit: res.skipped,
          ...(res.repeated.length ? { duplicates: res.repeated } : {}),
          // The plan counts keyword units: one per 10 results checked a day, so 2 each at depth 20.
          keyword_units: res.units,
          units_per_keyword: res.unitsPerKeyword,
          ...(res.unitsLeft != null ? { keyword_units_left: res.unitsLeft } : {}),
          message: res.message,
        };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "add_ai_prompts",
    {
      title: "Add AI prompts",
      description: `Adds prompts to AI visibility: questions a customer might ask an AI assistant, asked every Monday on each platform (${PLATFORM_KEYS.join(", ")}; default all). ${rules.hasPlans ? "Each prompt counts against the plan's prompt limit. " : ""}A prompt's \`keyword\` is checked for a Google AI Overview; left out it comes from the prompt, and an empty string skips that check. Prompts that name the brand are branded, and don't count toward visibility unless the project counts them.`,
      inputSchema: z.object({
        project,
        prompts: z
          .array(
            z.object({
              prompt: z.string().min(3).max(500),
              keyword: z.string().max(200).optional(),
              topic: z.string().max(200).optional().describe("A group such as a product line; prompts are rated per topic."),
            }),
          )
          .min(1)
          .max(100),
        platforms: z.array(z.enum(PLATFORM_KEYS as [string, ...string[]])).min(1).optional(),
        confirm,
      }),
      annotations: ADDS,
    },
    (args) =>
      run("add_ai_prompts", async () => {
        if (args.confirm) await counted();
        const res = await addPromptsOp(await scopeOf(args.project), actor, args.prompts, args.platforms ?? PLATFORM_KEYS, { dryRun: !args.confirm });
        const out = {
          added: res.added,
          already_tracked: res.already,
          ...(res.alreadyPrompts.length ? { already_tracked_prompts: res.alreadyPrompts } : {}),
          ...(res.branded.length ? { branded_prompts: res.branded } : {}),
          platforms: res.platforms,
          ...(res.monthlyUsd != null ? { monthly_usd: res.monthlyUsd } : {}),
          message: res.branded.length
            ? `${res.message} ${res.branded.length === 1 ? "1 prompt names" : `${res.branded.length} prompts name`} the brand. ${res.includesBranded ? "This project counts branded prompts in visibility." : "Visibility leaves branded prompts out unless the project counts them."} Leave the brand out to see whether AI names the site unprompted.`
            : res.message,
        };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "find_local_listing",
    {
      title: "Find a Google Maps listing",
      description:
        `Step 1 of Local SEO: searches Google Maps for a business by name and city and lists the listings found, each with a \`listing\` key for add_local_business and \`on_project_domain\`, false when its website is another site (null when it has none). ${COSTS} unless the same search ran in the last day.`,
      inputSchema: z.object({
        project,
        name: z.string().min(1).max(120).describe("The business name as it appears on Google Maps."),
        city: z.string().min(1).max(120),
        max_credits: maxCredits,
      }),
      annotations: RUNS,
    },
    (args) =>
      run("find_local_listing", async () => {
        const row = await resolveLiveProject(ws, args.project);
        const scope = projectScope(row);
        const quote = await findListingsOp(scope, args, { dryRun: true });
        if (!quote.cached && !covered(args.max_credits, quote.price.credits)) {
          if (!spends && args.max_credits != null) refuseSpend();
          return priced({ name: quote.name, city: quote.city, price: { credits: quote.price.credits }, ...usdOf(quote.price.usd), message: quote.message }, spends);
        }
        if (!quote.cached) await counted();
        // Quoted nothing because the search was saved: read that saved search, and never buy one.
        const res = await findListingsOp(scope, args, { savedSearchOnly: quote.cached });
        // A listing whose website is another site is likely another business: say so before it's tracked.
        const own = normalizeDomain(row.domain);
        const sameSite = (d: string | null) => {
          if (!d) return null;
          const host = normalizeDomain(d);
          return host === own || host.endsWith(`.${own}`) || own.endsWith(`.${host}`);
        };
        const listings = res.candidates.map((c) => ({
          listing: c.listing,
          title: c.title,
          address: c.address,
          category: c.category,
          domain: c.domain,
          on_project_domain: sameSite(c.domain),
          rating: c.rating,
          reviews: c.votes,
        }));
        const elsewhere = listings.filter((l) => l.on_project_domain === false);
        const warning = elsewhere.length
          ? ` ${plural(elsewhere.length, "listing")} ${elsewhere.length === 1 ? "links" : "link"} to a website other than ${row.domain}: ${[...new Set(elsewhere.map((l) => l.domain))].join(", ")}. Track one only if it's this project's business.`
          : "";
        return {
          listings,
          credits_spent: res.cached ? 0 : res.price.credits,
          message: res.message + warning,
        };
      }),
  );

  server.registerTool(
    "add_local_business",
    {
      title: "Track a Google Maps listing",
      description: `Step 2 of Local SEO: tracks a listing from find_local_listing (same name and city, plus its \`listing\` key, within a day of that search) on a grid of points around it. Grid ${GRID_SIZES.join(", ")} points across (default 5), radius ${RADII_MILES.join(", ")} miles (default 5). Weekly checks are on by default and ${SPEND} each week. It checks nothing until it has keywords.`,
      inputSchema: z.object({
        project,
        name: z.string().min(1).max(120),
        city: z.string().min(1).max(120),
        listing: z.string().min(1).max(200),
        weekly: z.boolean().optional(),
        grid_size: z.number().int().optional(),
        radius_miles: z.number().optional(),
        confirm,
      }),
      annotations: ADDS,
    },
    (args) =>
      run("add_local_business", async () => {
        // Weekly checks spend research credits every week, so a key that can't spend can only add a listing without them.
        if (!spends && args.weekly !== false)
          throw new ToolError(`Weekly checks ${SPEND} every week, and ${CANT_SPEND}. Call again with weekly: false to track the listing without them. ${NO_RESEARCH}`);
        if (args.confirm) await counted();
        const res = await addBusinessOp(
          await scopeOf(args.project),
          { name: args.name, city: args.city, listing: args.listing, scheduled: args.weekly, gridSize: args.grid_size, radiusMiles: args.radius_miles },
          // This tool takes no max_credits, so it never buys the search: it reads the one find_local_listing saved.
          { dryRun: !args.confirm, savedSearchOnly: true },
        );
        const out = { business_id: res.businessId, title: res.title, already_tracked: res.existing, message: res.message };
        return res.dryRun && !res.existing ? preview(out) : out;
      }),
  );

  server.registerTool(
    "add_local_keywords",
    {
      title: "Add Local SEO keywords",
      description: `Adds keywords (such as "plumber near me") to a tracked listing; each check searches every keyword at every grid point. At most ${MAX_KEYWORDS_PER_BUSINESS} per listing.`,
      inputSchema: z.object({
        project,
        business: z.number().int().describe("The listing's id, from get_local_seo or add_local_business."),
        keywords: z.array(z.string().max(120)).min(1).max(MAX_KEYWORDS_PER_BUSINESS),
        confirm,
      }),
      annotations: ADDS,
    },
    (args) =>
      run("add_local_keywords", async () => {
        const scope = await scopeOf(args.project);
        // A listing with weekly checks searches every keyword at every point each week, so a key that can't spend can't add to it.
        if (!spends && (await getBusiness(scope, args.business))?.scheduled)
          throw new ToolError(`This listing's weekly checks ${rules.hasPlans ? `spend ${rules.researchNoun} on` : "spend on DataForSEO for"} every keyword each week, and ${CANT_SPEND}. ${NO_RESEARCH}`);
        if (args.confirm) await counted();
        const res = await addLocalKeywordsOp(scope, args.business, args.keywords, { dryRun: !args.confirm });
        const out = { added: res.added, already_tracked: res.already, over_limit: res.overLimit, message: res.message };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "start_rank_check",
    {
      title: "Check rankings now",
      description:
        `Checks every tracked keyword's Google position now instead of waiting for the daily run. \`deep\` checks deeper and looks for AI Overviews, as the weekly sweep does. One check at a time per project; results arrive over the next few minutes (in get_rankings). A check ${COVERED} (\`credits: 0\`), like a site audit. A keyword that comes back missing or far below its recent best is looked up to twice more, so \`max_cost_usd\`, sent only to the owner's workspace, is the most it can cost SEOpen; most checks cost less.`,
      inputSchema: z.object({ project, deep: z.boolean().optional(), confirm }),
      annotations: RUNS,
    },
    (args) =>
      run("start_rank_check", async () => {
        if (args.confirm) await counted();
        const res = await startRankCheckOp(await scopeOf(args.project), { deep: args.deep }, { dryRun: !args.confirm });
        // Rank checks are covered by the plan, like audits: no credits, whatever the dollar figure.
        const out = {
          run_id: res.runId,
          keywords: res.keywords,
          depth: res.depth,
          credits: 0,
          cost: res.maxCostUsd != null ? RANK_CHECK_COST + OWN_COST : RANK_CHECK_COST,
          ...(res.maxCostUsd != null ? { max_cost_usd: cents(res.maxCostUsd) } : {}),
          message: res.message,
        };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "run_ai_visibility",
    {
      title: "Run AI visibility now",
      description:
        `Asks every active prompt on its platforms now instead of waiting for Monday's run${rules.hasPlans ? ", which the plan covers" : ""}. ${COSTS} (quoted first). One run by hand a week per project; answers arrive over the next few minutes (in get_ai_visibility).`,
      inputSchema: z.object({ project, max_credits: maxCredits }),
      annotations: RUNS,
    },
    (args) =>
      run("run_ai_visibility", async () => {
        const scope = await scopeOf(args.project);
        const quote = await startAiRunOp(scope, { dryRun: true });
        if (!covered(args.max_credits, quote.price.credits)) {
          if (!spends && args.max_credits != null) refuseSpend();
          return priced({ answers: quote.answers, ai_overview_checks: quote.aioChecks, price: quote.price, ...usdOf(quote.estimateUsd), message: quote.message }, spends);
        }
        await counted();
        const res = await startAiRunOp(scope);
        return { run_id: res.runId, answers: res.answers, ai_overview_checks: res.aioChecks, credits: res.price.credits, ...usdOf(res.estimateUsd), message: res.message };
      }),
  );

  server.registerTool(
    "start_site_audit",
    {
      title: "Start a site audit",
      description: `Crawls the project's site for technical SEO issues. Pages and JavaScript default to the project's last audit settings (500 pages without JavaScript at first); ${rules.hasPlans ? `the plan caps pages per audit (at most ${MAX_PAGES_LIMIT})` : `at most ${MAX_PAGES_LIMIT} pages per audit`}. An audit ${COVERED} (\`credits: 0\`), unlike the research tools${rules.hasPlans ? "; the plan caps how often audits run on Free and the trial" : ""}. One crawl at a time per project; the results are in get_audit_issues once it finishes.`,
      inputSchema: z.object({
        project,
        max_pages: z.number().int().min(1).max(MAX_PAGES_LIMIT).optional(),
        javascript: z.boolean().optional().describe("Render pages with JavaScript, for sites built with client-side frameworks. Costs more per page."),
        confirm,
      }),
      annotations: RUNS,
    },
    (args) =>
      run("start_site_audit", async () => {
        if (args.confirm) await counted();
        const res = await startCrawlOp(await resolveLiveProject(ws, args.project), actor, { maxPages: args.max_pages, enableJavascript: args.javascript }, { dryRun: !args.confirm });
        // Audits aren't a research module, so nothing here draws on credits (RESEARCH_MODULES in src/lib/billing/usage.ts).
        const out = {
          crawl_id: res.crawlId,
          max_pages: res.maxPages,
          javascript: res.enableJavascript,
          credits: 0,
          cost: res.estimateUsd != null ? AUDIT_COST + OWN_COST : AUDIT_COST,
          ...(res.estimateUsd != null ? { estimate_usd: res.estimateUsd } : {}),
          message: res.message,
        };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "start_local_check",
    {
      title: "Check a Google Maps listing now",
      description:
        `Searches every keyword of a tracked listing at every grid point now instead of waiting for its weekly check. ${COSTS} (quoted first). One check at a time per listing; the results are in get_local_seo.`,
      inputSchema: z.object({ project, business: z.number().int().describe("The listing's id, from get_local_seo."), max_credits: maxCredits }),
      annotations: RUNS,
    },
    (args) =>
      run("start_local_check", async () => {
        const scope = await scopeOf(args.project);
        const quote = await startLocalCheckOp(scope, args.business, { dryRun: true });
        if (!covered(args.max_credits, quote.price.credits)) {
          if (!spends && args.max_credits != null) refuseSpend();
          return priced({ keywords: quote.keywords, points: quote.points, price: { credits: quote.price.credits }, ...usdOf(quote.price.usd), message: quote.message }, spends);
        }
        await counted();
        const res = await startLocalCheckOp(scope, args.business);
        return { check_id: res.checkId, keywords: res.keywords, points: res.points, credits: res.price.credits, message: res.message };
      }),
  );

  server.registerTool(
    "save_keywords",
    {
      title: "Save keywords to a list",
      description: `Saves keywords to one of the project's keyword lists, creating the list when no list has that name. Takes metrics already looked up (volume, kd, cpc, intent); nothing is looked up or spent, and lists have no ${rules.hasPlans ? "plan " : ""}limit. Keywords already in the list are skipped, and the same keyword in other case or spacing is saved once and listed in \`duplicates\`. At most ${MAX_KEYWORDS_PER_SAVE} per call. The lists are in get_keyword_lists.`,
      inputSchema: z.object({
        project,
        list: z.string().min(1).max(MAX_LIST_NAME).describe("The list's name. A new name makes a new list."),
        keywords: z
          .array(
            z.object({
              keyword: z.string().min(1).max(700),
              volume: z.number().int().nullable().optional(),
              kd: z.number().min(0).max(100).nullable().optional(),
              cpc: z.number().min(0).nullable().optional(),
              intent: z.string().max(40).nullable().optional(),
            }),
          )
          .min(1)
          .max(MAX_KEYWORDS_PER_SAVE),
        source: z.string().max(200).optional().describe("Where they came from, such as teardown:example.com. Shown with each keyword."),
        market: z.union([z.string(), z.number().int()]).optional().describe("The country they were researched in, if not the project's own."),
        confirm,
      }),
      annotations: ADDS,
    },
    (args) =>
      run("save_keywords", async () => {
        if (args.confirm) await counted();
        let market: { locationCode: number; languageCode: string } | undefined;
        if (args.market != null) {
          const found = findMarket(args.market);
          if (!found) throw new ToolError(`Unknown market “${args.market}”. Use one of: ${LOCATIONS.map((l) => l.name).join(", ")}.`);
          market = { locationCode: found.code, languageCode: found.languageCode };
        }
        const res = await saveKeywordsOp(await scopeOf(args.project), { list: args.list, items: args.keywords, source: args.source, market }, { dryRun: !args.confirm });
        const out = {
          list_id: res.listId,
          list: res.list,
          new_list: res.newList,
          added: res.added,
          already_in_list: res.already,
          ...(res.repeated.length ? { duplicates: res.repeated } : {}),
          message: res.message,
        };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "save_teardown",
    {
      title: "Save a teardown",
      description: `Saves a competitor teardown to the project, shown on Domains → Teardowns in SEOpen: a summary, what the site does to win its traffic (findings), and 1 to ${TL.moves} moves for the user's own site. Plain text: blank lines split paragraphs, and Markdown and HTML show as typed. Nothing is looked up or spent. Without confirm: true it changes nothing and says what it would do.`,
      inputSchema: z.object({
        project,
        domain: z.string().min(3).max(253).describe("The site taken apart, such as example.com."),
        summary: z.string().min(1).max(TL.summary).describe("Two to four sentences: how the site gets its search traffic, and the one thing most worth copying."),
        findings: z
          .array(z.object({ title: z.string().min(1).max(TL.findingTitle), body: z.string().min(1).max(TL.findingBody) }))
          .max(TL.findings)
          .describe("Where the traffic comes from, the winning template, what earns links, the keywords that matter, and where it's weak. Say which figures are estimates."),
        moves: z
          .array(
            z.object({
              title: z.string().min(1).max(TL.moveTitle).describe("What to build or change, in a sentence."),
              why: z.string().min(1).max(TL.moveWhy).describe("The evidence from this teardown."),
              size: z.enum(MOVE_SIZES),
              first_step: z.string().min(1).max(TL.moveFirstStep),
            }),
          )
          .min(1)
          .max(TL.moves)
          .describe("Best first."),
        credits_spent: z.number().int().min(0).max(100000).optional().describe(`${CREDIT_UNIT} the teardown spent, as the lookups reported.`),
        market: z.union([z.string(), z.number().int()]).optional().describe("The country it was researched in, if not the project's own."),
        confirm,
      }),
      annotations: ADDS,
    },
    (args) =>
      run("save_teardown", async () => {
        if (args.confirm) await counted();
        let market: { locationCode: number; languageCode: string } | undefined;
        if (args.market != null) {
          const found = findMarket(args.market);
          if (!found) throw new ToolError(`Unknown market “${args.market}”. Use one of: ${LOCATIONS.map((l) => l.name).join(", ")}.`);
          market = { locationCode: found.code, languageCode: found.languageCode };
        }
        const res = await saveTeardownOp(
          await scopeOf(args.project),
          { domain: args.domain, summary: args.summary, findings: args.findings, moves: args.moves.map((m) => ({ title: m.title, why: m.why, size: m.size, firstStep: m.first_step })), creditsSpent: args.credits_spent, market },
          { dryRun: !args.confirm, savedBy: (await connectionName(principal)) ?? undefined },
        );
        const out = { teardown_id: res.id, domain: res.domain, ...(res.earlier.length ? { earlier_teardown_ids: res.earlier } : {}), message: res.message };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "create_content_brief",
    {
      title: "Create a content brief",
      description: `Saves a content brief for one keyword, shown on Keyword research → Briefs: the keyword's metrics, what kind of page ranks in the top 10 (and a warning when fewer than 6 of 10 agree), the AI Overview and the pages it cites, questions people ask, the headings the top 3 share, a headings-only outline, owner-only inputs to fill, and internal links from the project's audit and Search Console data. Never the article. page_type: guide, vs (X vs Y, Y defaults to the first tracked competitor), alternatives (${OPTION_RANGE.min} to ${OPTION_RANGE.max} options, never the site itself first, one drawback each), best (best X for Y) or pricing; every price needs the date it was checked. Saved lookups are free; the rest ${rules.hasPlans ? `costs ${rules.researchNoun}, quoted first` : "spends on DataForSEO and is quoted first"}. Left out or with max_credits below the price, nothing is saved or spent. The saved brief is in get_content_brief.`,
      inputSchema: z.object({
        project,
        keyword: z.string().min(1).max(700).describe("The main keyword, as people search it."),
        page_type: z.enum(PAGE_TYPES).optional().describe("Default guide."),
        x: z.string().max(120).optional().describe("The X in X vs Y, X alternatives, best X for Y or X pricing. Read from the keyword when left out."),
        y: z.string().max(120).optional().describe("The Y in X vs Y or best X for Y."),
        merged: z.array(z.string().max(700)).max(MAX_MERGED).optional().describe("Other keywords the same page should answer."),
        options: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              url: z.string().max(2000).optional(),
              price: z.string().max(120).optional(),
              price_checked_on: z.string().max(10).optional().describe("YYYY-MM-DD, required with a price."),
              drawback: z.string().max(400).optional(),
            }),
          )
          .max(OPTION_RANGE.max)
          .optional()
          .describe("For alternatives, vs and best pages. Left out, they're proposed from tracked competitors and the top 10, for the owner to check."),
        confirm,
        max_credits: maxCredits,
      }),
      annotations: RUNS,
    },
    (args) =>
      run("create_content_brief", async () => {
        const scope = await scopeOf(args.project);
        const input = {
          keyword: args.keyword,
          pageType: args.page_type ?? "guide",
          x: args.x ?? null,
          y: args.y ?? null,
          merged: args.merged,
          options: args.options?.map((o) => ({ name: o.name, url: o.url ?? null, price: o.price ?? null, priceCheckedOn: o.price_checked_on ?? null, drawback: o.drawback ?? null })),
        };
        const quote = await createBriefOp(scope, actor, input, { dryRun: true });
        if (quote.state !== "preview") throw new ToolError(quote.message);
        const summary = { keyword: quote.keyword, page_type: quote.pageType, x: quote.x, y: quote.y, merged: quote.merged, credits: quote.credits };
        if (!args.confirm) return preview({ ...summary, message: quote.message }, quote.credits ? (spends ? `Ask the user, then call again with confirm: true and max_credits of at least ${quote.credits}.` : NO_RESEARCH) : undefined);
        if (quote.credits > 0 && !spends) refuseSpend();
        if ((args.max_credits ?? 0) < quote.credits) return priced({ ...summary, message: quote.message, price: { credits: quote.credits } }, spends);
        await counted();
        // A key that can't spend covers no price, whatever max_credits it sent.
        const res = await createBriefOp(scope, actor, input, { maxCredits: spends ? (args.max_credits ?? 0) : 0 });
        if (res.state === "needs_credits") return priced({ ...summary, message: `${res.message} The price changed since the quote.`, price: { credits: res.credits } }, spends);
        if (res.state !== "created") throw new ToolError(res.message);
        return { brief_id: res.id, credits: res.credits, message: res.message, next: "Read it with get_content_brief, and ask the user for what's under To fill." };
      }),
  );

  server.registerTool(
    "update_ai_action_status",
    {
      title: "Update AI visibility actions",
      description: `Marks actions from get_ai_actions open, done or dismissed, as the Actions tab in SEOpen does. Only actions get_ai_actions lists now can change. It records a decision: nothing is posted or sent anywhere. Up to ${MAX_ACTION_CHANGES} at once. Without confirm: true it changes nothing and says what it would do. \`done\` is for work the user says is done.`,
      inputSchema: z.object({
        project,
        actions: z
          .array(
            z.object({
              prompt_id: z.number().int().describe("From get_ai_actions."),
              kind: z.enum(ACTION_KINDS),
              url: z.string().max(2000).optional().describe("The page, for featured and thread; left out for write."),
            }),
          )
          .min(1)
          .max(MAX_ACTION_CHANGES),
        status: z.enum(ACTION_STATUSES),
        confirm,
      }),
      annotations: { ...ADDS, destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      run("update_ai_action_status", async () => {
        if (args.confirm) await counted();
        const refs = args.actions.map((a) => ({ promptId: a.prompt_id, kind: a.kind, url: a.url }));
        const res = await setActionStatusOp(await scopeOf(args.project), refs, args.status, { dryRun: !args.confirm });
        const ref = (r: { promptId: number; kind: string; url?: string | null }) => ({ prompt_id: r.promptId, kind: r.kind, ...(r.url ? { url: r.url } : {}) });
        const out = { status: res.status, changed: res.changed.map(ref), skipped: res.skipped.map((r) => ({ ...ref(r), why: r.why })), message: res.message };
        return res.dryRun ? preview(out) : out;
      }),
  );

  server.registerTool(
    "update_alert_rule",
    {
      title: "Turn an alert rule on or off",
      description:
        "Turns one of the project's alert rules (from list_alerts) on or off, as the Alerts page in SEOpen does. Turning a rule off stops new alerts of that kind and keeps the history. Without confirm: true it changes nothing and says what it would do. Which rules are on is the user's choice.",
      inputSchema: z.object({ project, rule: z.enum(ALERT_RULES), enabled: z.boolean(), confirm }),
      annotations: { ...ADDS, destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      run("update_alert_rule", async () => {
        if (args.confirm) await counted();
        const res = await setAlertRuleOp(await scopeOf(args.project), actor, { rule: args.rule, enabled: args.enabled }, { dryRun: !args.confirm });
        const out = { rule: res.rule, label: res.label, enabled: res.enabled, changed: res.changed, message: res.message };
        return args.confirm ? out : preview(out);
      }),
  );

  server.registerTool(
    "submit_indexnow",
    {
      title: "Tell Bing and IndexNow engines about pages",
      description: `Sends pages of the project's site to IndexNow, which passes them to Bing, Yandex, Seznam, Naver and the other IndexNow engines so they crawl them soon. Google doesn't use IndexNow. Send \`urls\` (up to ${MAX_SUBMIT_URLS}, on the site the key file is on) for pages you just changed, or leave it out to send every sitemap page that's new or changed since it was last sent. It needs the project's key file on the site (see get_indexing's indexnow.key_file); without it the tool says how to add it. Free. Without confirm: true it sends nothing and says what it would send. It's for pages the user asked to send, or a deployed change they approved.`,
      inputSchema: z.object({
        project,
        urls: z.array(z.url()).min(1).max(MAX_SUBMIT_URLS).optional().describe("Full URLs to send. Left out: the sitemap's new and changed pages."),
        confirm,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (args) =>
      run("submit_indexnow", async () => {
        if (args.confirm) await counted();
        const res = await submitIndexNowOp(await scopeOf(args.project), actor, { urls: args.urls }, { dryRun: !args.confirm });
        if (args.confirm) return res;
        const { wouldSend, ...rest } = "wouldSend" in res ? res : { ...res, wouldSend: 0 };
        const out = { ...rest, would_send: wouldSend };
        return preview(out);
      }),
  );
}
