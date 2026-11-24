import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The file `@/billing-provider` resolves to, relative to the repo root: getseopen.com's Stripe
 * provider where it exists, core's no-billing one otherwise (provider.ts). next.config.ts and
 * vitest.config.ts call this. tsconfig.json lists both files, Stripe first, for tsc and tsx (provider.ts).
 */
export function billingProviderFile(root: string): string {
  const stripe = "./src/lib/billing/stripe-provider.ts";
  return existsSync(path.join(root, stripe)) ? stripe : "./src/lib/billing/no-provider.ts";
}
