import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The file `@/admin-extra` resolves to, relative to the repo root: the hosted service's extra Admin
 * pages where that file exists, none otherwise, so a self-hosted copy never links to a page it
 * doesn't have. next.config.ts and vitest.config.ts call this. tsconfig.json lists both files, this
 * one first, for tsc and tsx (`@/admin-*`). The same pattern as `@/billing-provider` (src/lib/billing/provider.ts).
 */
export function adminExtraFile(root: string): string {
  const extra = "./src/components/shell/admin-extra.ts";
  return existsSync(path.join(root, extra)) ? extra : "./src/components/shell/no-admin-extra.ts";
}
