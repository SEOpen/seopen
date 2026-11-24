import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Which local database the test suite uses. The main checkout (and CI) uses `seopen_test`. A git
 * worktree gets its own, `seopen_test_<folder>_<hash>`, so suites run from different worktrees at
 * the same time don't wipe and re-migrate each other's schema. `SEOPEN_TEST_DB` overrides
 * the name, and must itself look like a test database. test-global-setup.ts creates it when missing.
 */
export const TEST_DATABASE_PATTERN = /^seopen_test(_[a-z0-9_]+)?$/;

export function testDatabaseName(root: string, override = process.env.SEOPEN_TEST_DB): string {
  if (override) {
    if (!TEST_DATABASE_PATTERN.test(override)) throw new Error(`SEOPEN_TEST_DB must start with seopen_test, got "${override}".`);
    return override;
  }
  // In a worktree `.git` is a file pointing at the main repository; in the main checkout it's a folder.
  let isWorktree = false;
  try {
    isWorktree = statSync(join(root, ".git")).isFile();
  } catch {
    // No .git at all (an exported tree): the plain name.
  }
  if (!isWorktree) return "seopen_test";
  const folder = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 6);
  return `seopen_test_${folder ? `${folder}_` : ""}${hash}`;
}

/** True when a connection URL names a test database, so no test can reach a real one. */
export function isTestDatabaseUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return TEST_DATABASE_PATTERN.test(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
}
