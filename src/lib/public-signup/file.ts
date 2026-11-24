import { existsSync } from "node:fs";
import path from "node:path";

/** The parts of public sign-up core asks for (types.ts). */
export const PUBLIC_SIGNUP_PARTS = ["server", "page", "client"] as const;

/**
 * The file `@/public-signup/<part>` resolves to, relative to the repo root: a hosted service's own
 * sign-up in `hosted/` where that folder exists, none otherwise. next.config.ts and vitest.config.ts
 * call this; tsconfig.json lists both folders for types and tsx. The same pattern as
 * `@/plan-policy` (src/lib/billing/policy-file.ts).
 */
export function publicSignupFile(root: string, part: (typeof PUBLIC_SIGNUP_PARTS)[number]): string {
  const ext = part === "server" ? "ts" : "tsx";
  const hosted = `./src/lib/public-signup/hosted/${part}.${ext}`;
  return existsSync(path.join(root, hosted)) ? hosted : `./src/lib/public-signup/none/${part}.${ext}`;
}

/** The aliases for a bundler: `@/public-signup/server` and the rest, each to its file. */
export function publicSignupAliases(root: string): Record<string, string> {
  return Object.fromEntries(PUBLIC_SIGNUP_PARTS.map((part) => [`@/public-signup/${part}`, publicSignupFile(root, part)]));
}
