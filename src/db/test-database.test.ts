import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTestDatabaseUrl, testDatabaseName } from "./test-database";

function checkout(kind: "main" | "worktree", folder = "repo"): string {
  const root = join(mkdtempSync(join(tmpdir(), "seopen-db-")), folder);
  mkdirSync(root);
  if (kind === "main") mkdirSync(join(root, ".git"));
  else writeFileSync(join(root, ".git"), "gitdir: /somewhere/.git/worktrees/x\n");
  return root;
}

describe("testDatabaseName", () => {
  it("keeps seopen_test for the main checkout", () => {
    expect(testDatabaseName(checkout("main"), "")).toBe("seopen_test");
  });

  it("gives each worktree its own database", () => {
    const a = testDatabaseName(checkout("worktree", "t3-09A62487"), "");
    const b = testDatabaseName(checkout("worktree", "t3-09A62487"), "");
    expect(a).toMatch(/^seopen_test_t3_09a62487_[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });

  it("takes an override only when it names a test database", () => {
    expect(testDatabaseName(checkout("main"), "seopen_test_mine")).toBe("seopen_test_mine");
    expect(() => testDatabaseName(checkout("main"), "seopen")).toThrow();
    expect(() => testDatabaseName(checkout("main"), "seopen_test; drop")).toThrow();
  });
});

describe("isTestDatabaseUrl", () => {
  it("accepts test databases only", () => {
    expect(isTestDatabaseUrl("postgres://localhost:5432/seopen_test")).toBe(true);
    expect(isTestDatabaseUrl("postgres://localhost:5432/seopen_test_bugs_abc123")).toBe(true);
    expect(isTestDatabaseUrl("postgres://localhost:5432/seopen")).toBe(false);
    expect(isTestDatabaseUrl("postgres://u:p@prod.example.com:25060/defaultdb?x=seopen_test")).toBe(false);
    expect(isTestDatabaseUrl(undefined)).toBe(false);
  });
});
