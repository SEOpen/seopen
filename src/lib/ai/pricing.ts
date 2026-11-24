import type { BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** List prices in dollars per million tokens (Anthropic's pricing, checked 2026-11-12). */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};
/** A model this table doesn't list (a fallback the server chose) is priced high rather than low. */
const UNKNOWN_PRICE = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

type Tokens = Pick<BetaUsage, "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">;

const priced = (model: string, u: Tokens) => {
  const p = PRICES[model] ?? UNKNOWN_PRICE;
  return (u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1_000_000;
};

/**
 * What a response cost. With a server-side fallback, `usage.iterations` lists each model that ran:
 * a `fallback_message` entry names its own model, the others ran on the requested one.
 */
export function claudeCostUsd(requested: string, usage: Tokens & { iterations?: unknown }): number {
  const iterations = usage.iterations as (Tokens & { type: string; model?: string })[] | null | undefined;
  if (!iterations?.length) return priced(requested, usage);
  return iterations.reduce((sum, it) => sum + priced(it.type === "fallback_message" && it.model ? it.model : requested, it), 0);
}
