import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the DataForSEO client can't see from its arguments: which background job a call is made
 * for (so a refused call pauses that job with a banner instead of failing every day), whether
 * it counts as research, and who started the work. The worker sets the job for every handler
 * (src/worker.ts).
 */
export interface BillingContext {
  job?: { name: string; data: unknown };
  /**
   * "plan": covered by the plan's limits, not research credits (e.g. the weekly backlinks snapshot).
   * "research": spends research credits whatever the module (an AI run started by hand).
   */
  meter?: "plan" | "research";
  /** "mcp": an AI agent started this work. The ledger records it, and jobs enqueued meanwhile carry it on. */
  source?: "mcp";
}

const storage = new AsyncLocalStorage<BillingContext>();

export const billingContext = (): BillingContext => storage.getStore() ?? {};

export function withBillingContext<T>(ctx: BillingContext, fn: () => T): T {
  return storage.run({ ...billingContext(), ...ctx }, fn);
}

/** The ledger's `source` for work done now. */
export const ledgerSource = (): "app" | "mcp" => billingContext().source ?? "app";

/** The source a job's payload carries (set by `enqueue`), for the worker to restore. */
export const sourceOf = (data: unknown): BillingContext["source"] =>
  data && typeof data === "object" && (data as { source?: unknown }).source === "mcp" ? "mcp" : undefined;

/** Runs `fn` with its paid calls charged to the plan, not to research credits. */
export const onPlanMeter = <T>(fn: () => T): T => withBillingContext({ meter: "plan" }, fn);

/** Runs `fn` with its paid calls charged to research credits, whatever their module. */
export const onResearchMeter = <T>(fn: () => T): T => withBillingContext({ meter: "research" }, fn);

/** Whether a call of this module, made now, counts toward research credits. */
export function countsAsResearch(module: string, researchModules: ReadonlySet<string>): boolean {
  const { meter } = billingContext();
  if (meter) return meter === "research";
  return researchModules.has(module);
}
