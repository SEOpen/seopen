import { existsSync } from "node:fs";
import path from "node:path";

/** The plan policy's parts (policy.ts). */
export const PLAN_POLICY_PARTS = ["rules", "hooks", "ui", "shell", "admin"] as const;

/**
 * The file `@/plan-policy/<part>` resolves to, relative to the repo root: the hosted service's plans
 * in `plan-policy/` where that folder exists, core's no-plans copy in `self-hosted/` otherwise.
 * next.config.ts and vitest.config.ts call this; tsconfig.json lists both folders for types and tsx.
 */
export function planPolicyFile(root: string, part: (typeof PLAN_POLICY_PARTS)[number]): string {
  const ext = part === "ui" || part === "shell" ? "tsx" : "ts";
  const hosted = `./src/lib/billing/plan-policy/${part}.${ext}`;
  return existsSync(path.join(root, hosted)) ? hosted : `./src/lib/billing/self-hosted/${part}.${ext}`;
}

/** The aliases for a bundler: `@/plan-policy/rules` and the rest, each to its file. */
export function planPolicyAliases(root: string): Record<string, string> {
  return Object.fromEntries(PLAN_POLICY_PARTS.map((part) => [`@/plan-policy/${part}`, planPolicyFile(root, part)]));
}
