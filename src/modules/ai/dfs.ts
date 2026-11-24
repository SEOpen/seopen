/** DataForSEO calls for the ai module. Everything goes through the shared, cost-capped client. */
import { dfsGet, dfsPost, taskResults, TTL, type DfsTask } from "@/lib/dataforseo/client";
import type { ProjectScope } from "@/lib/workspace";
import { LLM_MENTIONS_PLATFORMS, platformDef, type PlatformKey } from "./platforms";
import { SUGGEST_LOOKUP_USD } from "./prompts";
import type {
  LlmResponseResult,
  MultiTargetResult,
  RankedKeywordItem,
  SerpItem,
  SerpResult,
  SiteKeywordItem,
} from "./types";

/**
 * Project context for paid calls. `estimateUsd` (a whole run's estimate) goes to the client's cap
 * check, so a run that would cross the monthly cap is refused before anything is spent.
 */
export interface DfsCtx {
  /** The workspace whose cap, ledger and cache the call uses. */
  workspaceId: number;
  projectId: number;
  locationCode: number;
  estimateUsd?: number;
  /** What one task is expected to cost. Every call reserves at least this for each of its tasks. */
  perTaskUsd?: number;
}

/**
 * What a call of `tasks` tasks reserves: the run's estimate when it's the call carrying it, and never
 * less than its own tasks' price. Neither set leaves the client's default.
 */
function callEstimate(ctx: DfsCtx, tasks: number, carriesRun: boolean): number | undefined {
  const run = carriesRun ? ctx.estimateUsd : undefined;
  if (ctx.perTaskUsd === undefined) return run;
  return Math.max(run ?? 0, tasks * ctx.perTaskUsd);
}

/** DataForSEO country location codes are 2000 + ISO 3166 numeric. Alpha-2 for web_search localisation. */
const ISO2: Record<number, string> = {
  2840: "US", 2826: "GB", 2124: "CA", 2036: "AU", 2554: "NZ", 2372: "IE", 2356: "IN", 2276: "DE",
  2250: "FR", 2724: "ES", 2484: "MX", 2076: "BR", 2380: "IT", 2528: "NL", 2752: "SE", 2392: "JP",
};

export const countryIso = (locationCode: number) => ISO2[locationCode];

/** Task states we care about: 40601/40602 mean "not ready yet". */
const NOT_READY = new Set([40601, 40602]);

/**
 * The most an answer may be, in tokens. DataForSEO's default for every LLM response endpoint, pinned
 * so a change on their side can't lengthen answers past what the per-answer estimate assumes. In
 * range on all four (1 to 4096) and above reasoning models' 1024 floor. Web search and reasoning
 * can still run a little over, per their docs.
 */
export const MAX_OUTPUT_TOKENS = 2048;

function llmBody(platform: PlatformKey, prompt: string, locationCode: number, tag?: string) {
  const def = platformDef(platform)!;
  const iso = countryIso(locationCode);
  return {
    user_prompt: prompt.slice(0, 500),
    model_name: def.model,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    ...(platform === "perplexity" ? {} : { web_search: def.webSearch }),
    ...(iso && def.countryParam ? { web_search_country_iso_code: iso } : {}),
    ...(tag ? { tag } : {}),
  };
}

/** Post Standard-queue tasks (≤100 per call). Returns DataForSEO's task list, in request order. */
export async function postLlmTasks(
  platform: PlatformKey,
  items: { prompt: string; tag: string }[],
  ctx: DfsCtx,
): Promise<DfsTask[]> {
  const out: DfsTask[] = [];
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const res = await dfsPost(
      `ai_optimization/${platform}/llm_responses/task_post`,
      batch.map((it) => llmBody(platform, it.prompt, ctx.locationCode, it.tag)),
      { module: "ai", workspaceId: ctx.workspaceId, projectId: ctx.projectId, ttlSeconds: 0, estimateUsd: callEstimate(ctx, batch.length, i === 0) },
    );
    out.push(...res.tasks);
  }
  return out;
}

export type TaskOutcome<R> =
  | { state: "pending" }
  | { state: "done"; result: R | null; cost: number }
  | { state: "failed"; error: string; code: number };

function outcome<R>(task: DfsTask<R> | undefined): TaskOutcome<R> {
  if (!task) return { state: "failed", error: "DataForSEO returned no task", code: 0 };
  if (NOT_READY.has(task.status_code)) return { state: "pending" };
  if (task.status_code === 40102) return { state: "done", result: null, cost: task.cost ?? 0 };
  if (task.status_code !== 20000) return { state: "failed", error: task.status_message, code: task.status_code };
  return { state: "done", result: task.result?.[0] ?? null, cost: task.cost ?? 0 };
}

/** Fetch a Standard task (free). */
export async function getLlmTask(platform: PlatformKey, taskId: string, scope: ProjectScope) {
  const res = await dfsGet<LlmResponseResult>(`ai_optimization/${platform}/llm_responses/task_get/${taskId}`, {
    module: "ai",
    ...scope,
    free: true,
  });
  return outcome(res.tasks?.[0]);
}

/** Ask a Live-only platform (Perplexity) and wait for the answer. */
export async function liveLlm(platform: PlatformKey, prompt: string, ctx: DfsCtx) {
  const res = await dfsPost<LlmResponseResult>(
    `ai_optimization/${platform}/llm_responses/live`,
    [llmBody(platform, prompt, ctx.locationCode)],
    { module: "ai", workspaceId: ctx.workspaceId, projectId: ctx.projectId, ttlSeconds: 0, estimateUsd: callEstimate(ctx, 1, true) },
  );
  return outcome(res.tasks?.[0]);
}

/** Post weekly AI Overview checks: a Standard Google SERP task per keyword with async AIO loading. */
export async function postAioTasks(
  items: { keyword: string; tag: string }[],
  ctx: DfsCtx & { languageCode: string },
): Promise<DfsTask[]> {
  const out: DfsTask[] = [];
  for (let i = 0; i < items.length; i += 100) {
    const batch = items.slice(i, i + 100);
    const res = await dfsPost(
      "serp/google/organic/task_post",
      batch.map((it) => ({
        keyword: it.keyword.slice(0, 700),
        location_code: ctx.locationCode,
        language_code: ctx.languageCode,
        device: "desktop",
        depth: 10,
        load_async_ai_overview: true,
        tag: it.tag,
      })),
      { module: "ai", workspaceId: ctx.workspaceId, projectId: ctx.projectId, ttlSeconds: 0, estimateUsd: callEstimate(ctx, batch.length, i === 0) },
    );
    out.push(...res.tasks);
  }
  return out;
}

export async function getAioTask(taskId: string, scope: ProjectScope) {
  const res = await dfsGet<SerpResult>(`serp/google/organic/task_get/advanced/${taskId}`, { module: "ai", ...scope, free: true });
  return outcome(res.tasks?.[0]);
}

/** The AI Overview on a SERP, if any: its text and every reference (top-level and per section). */
export function aiOverviewFrom(result: SerpResult | null): { present: boolean; text: string; references: { url: string; title: string | null }[] } {
  const aio = result?.items?.find((i) => i.type === "ai_overview");
  if (!aio) return { present: false, text: "", references: [] };
  const refs: { url: string; title: string | null }[] = [];
  const walk = (it: SerpItem) => {
    for (const r of it.references ?? []) if (r.url) refs.push({ url: r.url, title: r.title ?? r.source ?? null });
    for (const sub of it.items ?? []) walk(sub);
  };
  walk(aio);
  const text = aio.markdown ?? (aio.items ?? []).map((i) => i.markdown ?? i.text ?? "").join("\n\n");
  return { present: true, text, references: refs };
}

export interface DomainMentions {
  domain: string;
  /** "google" (AI Overviews) or "chat_gpt". */
  platform: string;
  mentions: number;
  aiSearchVolume: number;
  topSources: { key: string; mentions: number }[];
}

/** The calls behind a Mentions refresh: one domain, or several. */
export const LLM_MENTIONS_ENDPOINTS = ["ai_optimization/llm_mentions/target_metrics/live", "ai_optimization/llm_mentions/multi_target_metrics/live"];

/**
 * LLM Mentions for up to 10 domains in a single task ($0.10), cached for a week. With no
 * `platform` set, each target's `platform` array splits mentions into google and chat_gpt.
 * Top sources are for both platforms together, so they are stored on every row of a domain.
 */
export async function fetchLlmMentions(
  brands: { domain: string; domains: string[] }[],
  ctx: DfsCtx & { languageCode: string },
): Promise<DomainMentions[]> {
  const list = brands.slice(0, 10);
  const targets = list.map((b) => b.domain);
  if (!targets.length) return [];
  // Each brand is one target set: its domain plus alias domains (e.g. alphanote.example + alphanote.test).
  const entities = (b: { domains: string[] }) => b.domains.slice(0, 10).map((d) => ({ domain: d, include_subdomains: true }));
  // multi_target_metrics needs at least 2 target sets; a lone domain goes to target_metrics.
  const single = targets.length === 1;
  const res = await dfsPost<MultiTargetResult>(
    LLM_MENTIONS_ENDPOINTS[single ? 0 : 1],
    [
      {
        location_code: ctx.locationCode,
        language_code: ctx.languageCode,
        internal_list_limit: 5,
        ...(single
          ? { target: entities(list[0]) }
          : { targets: list.map((b) => ({ key: b.domain, target: entities(b) })) }),
      },
    ],
    { module: "ai", workspaceId: ctx.workspaceId, projectId: ctx.projectId, ttlSeconds: TTL.week, estimateUsd: callEstimate(ctx, 1, true) },
  );
  const result = taskResults(res)[0];
  const groups = single ? [{ key: targets[0], ...(result?.aggregated_metrics ?? {}) }] : (result?.items ?? []);
  const out: DomainMentions[] = [];
  for (const d of targets) {
    const g = groups.find((x) => x.key === d);
    const topSources = (g?.sources_domain ?? []).map((s) => ({ key: s.key, mentions: s.mentions }));
    for (const platform of LLM_MENTIONS_PLATFORMS) {
      const p = (g?.platform ?? []).find((x) => x.key === platform);
      out.push({ domain: d, platform, mentions: p?.mentions ?? 0, aiSearchVolume: p?.ai_search_volume ?? 0, topSources });
    }
  }
  return out;
}

/**
 * The project's keywords for "Suggest prompts": ranked keywords, or keywords for the site when it ranks
 * for few. Both are research lookups, each reserved and capped at the price the button showed.
 */
export async function fetchProjectKeywords(
  domain: string,
  ctx: DfsCtx & { languageCode: string },
): Promise<{ keyword: string; volume: number }[]> {
  const base = { location_code: ctx.locationCode, language_code: ctx.languageCode, limit: 100 };
  const ranked = await dfsPost<{ items?: RankedKeywordItem[] | null }>(
    "dataforseo_labs/google/ranked_keywords/live",
    [
      {
        ...base,
        target: domain,
        // Keywords we actually rank for (top 30), so suggestions stay on topic.
        filters: [["ranked_serp_element.serp_item.rank_group", "<=", 30]],
        order_by: ["keyword_data.keyword_info.search_volume,desc"],
      },
    ],
    suggestCall(ctx),
  );
  const out = (taskResults(ranked)[0]?.items ?? []).map((i) => ({
    keyword: i.keyword_data.keyword,
    volume: i.keyword_data.keyword_info?.search_volume ?? 0,
  }));
  if (out.length >= 10) return out;
  const site = await dfsPost<{ items?: SiteKeywordItem[] | null }>(
    "dataforseo_labs/google/keywords_for_site/live",
    [{ ...base, target: domain, order_by: ["keyword_info.search_volume,desc"] }],
    suggestCall(ctx),
  );
  for (const i of taskResults(site)[0]?.items ?? []) out.push({ keyword: i.keyword, volume: i.keyword_info?.search_volume ?? 0 });
  return out;
}

/** A "Suggest prompts" lookup: research credits, reserved and charged at no more than the price shown. */
const suggestCall = (ctx: DfsCtx) => ({
  module: "ai" as const,
  workspaceId: ctx.workspaceId,
  projectId: ctx.projectId,
  ttlSeconds: TTL.week,
  research: true,
  estimateUsd: SUGGEST_LOOKUP_USD,
  maxChargeUsd: SUGGEST_LOOKUP_USD,
});
