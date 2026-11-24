/** AI platforms we ask tracked prompts on, via DataForSEO's AI Optimization `llm_responses`. */

export type PlatformKey = "chat_gpt" | "perplexity" | "gemini" | "claude";

export interface PlatformDef {
  key: PlatformKey;
  label: string;
  /**
   * Live answers during the run. Standard (task_post → task_get) is $0.0004 cheaper per answer but
   * can take hours, so no platform uses it now; Perplexity is Live only anyway.
   */
  mode: "standard" | "live";
  /** A small, cheap model with web search, so answers carry citations. */
  model: string;
  webSearch: boolean;
  /** Accepts `web_search_country_iso_code` (Gemini rejects it with 40501). */
  countryParam: boolean;
  /** Fallback cost per answer (USD) before we have our own history. Replaced by observed averages. */
  defaultCostUsd: number;
}

/**
 * One Perplexity answer: `llm_responses` Live with sonar is $0.0006 plus the token cost passed
 * through (docs/dataforseo.md), about $0.006 measured. The free AI visibility checker reserves it too.
 */
export const PERPLEXITY_ANSWER_USD = 0.006;

export const PLATFORMS: PlatformDef[] = [
  { key: "chat_gpt", label: "ChatGPT", mode: "live", model: "gpt-5.4-mini", webSearch: true, countryParam: true, defaultCostUsd: 0.026 },
  { key: "perplexity", label: "Perplexity", mode: "live", model: "sonar", webSearch: true, countryParam: true, defaultCostUsd: PERPLEXITY_ANSWER_USD },
  { key: "gemini", label: "Gemini", mode: "live", model: "gemini-3.6-flash", webSearch: true, countryParam: false, defaultCostUsd: 0.031 },
  { key: "claude", label: "Claude", mode: "live", model: "claude-haiku-5-5", webSearch: true, countryParam: true, defaultCostUsd: 0.012 },
];

export const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);

export function platformDef(key: string): PlatformDef | undefined {
  return PLATFORMS.find((p) => p.key === key);
}

export function platformLabel(key: string): string {
  return platformDef(key)?.label ?? key;
}

/** Standard SERP task with load_async_ai_overview: $0.0006 base + $0.0006 add-on (refunded without an AIO). */
export const AIO_COST_USD = 0.0012;
/** LLM Mentions multi_target_metrics: $0.10 per task (+$0.001 per row); one task covers both platforms. */
export const LLM_MENTIONS_PLATFORMS = ["google", "chat_gpt"] as const;
export const LLM_MENTIONS_COST_USD = 0.101;
/** Weekly runs per month. */
export const RUNS_PER_MONTH = 52 / 12;
