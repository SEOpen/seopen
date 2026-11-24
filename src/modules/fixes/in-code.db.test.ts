import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** The open fixes an agent can make in the code, as the Fixes page counts them, against seopen_test. */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { fixDef } = await import("./catalog");
const { fixCounts, listFixes, openInCodeCount } = await import("./queries");

async function seed() {
  const [ws] = await db.insert(s.workspaces).values({ name: `in-code-${Date.now()}-${Math.random()}`, plan: "internal" }).returning();
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "In code", domain: "in-code.example" }).returning();
  const [other] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Other", domain: "other.example" }).returning();
  const scope = { workspaceId: ws.id, projectId: project.id };
  const fix = (code: string, path: string, status = "open", extra: Record<string, unknown> = {}) => ({ ...scope, source: code.startsWith("gsc-") ? "search_console" : "audit", code, url: `https://in-code.example${path}`, status, ...extra });
  await db.insert(s.fixes).values([
    // Open, in the code: five.
    fix("missing-title", "/a"),
    fix("missing-title", "/b"),
    fix("title-too-long", "/c"),
    fix("gsc-low-ctr", "/d"),
    fix("gsc-not-indexed", "/e"),
    // Open, but writing or hosting, or a code the catalogue doesn't know (read as writing).
    fix("thin-content", "/f"),
    fix("gsc-striking-distance", "/g"),
    fix("made-up-code", "/h"),
    fix("http-5xx", "/i"),
    // In the code, but not open.
    fix("missing-title", "/j", "applied"),
    fix("missing-h1", "/k", "dismissed"),
    fix("missing-title", "/l", "live"),
    // Folded into its pair: resolved, so never open.
    fix("duplicate-content", "/m", "resolved", { evidence: { covered_by: "https://in-code.example/n" } }),
  ]);
  // Another project's open fix in the code, in the same workspace.
  await db.insert(s.fixes).values({ workspaceId: ws.id, projectId: other.id, source: "audit", code: "missing-title", url: "https://other.example/a" });
  return scope;
}

/** What the page used to count: up to 5,000 open rows, then the ones of kind code. */
async function countedFromRows(scope: { workspaceId: number; projectId: number }) {
  const inCode = await listFixes(scope, { status: ["open"] }, 5_000);
  return inCode.rows.filter((f) => fixDef(f.code).kind === "code").length;
}

describe.skipIf(!ready)("open fixes in the code", () => {
  it("counts this project's open fixes of kind code", async () => {
    const scope = await seed();
    expect(await countedFromRows(scope)).toBe(5);
    expect(await openInCodeCount(scope)).toBe(5);
    expect((await fixCounts(scope)).open).toBe(9);
  });

  it("is zero with nothing stored", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `in-code-empty-${Date.now()}`, plan: "internal" }).returning();
    const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: "Empty", domain: "empty.example" }).returning();
    const scope = { workspaceId: ws.id, projectId: project.id };
    expect(await countedFromRows(scope)).toBe(0);
    expect(await openInCodeCount(scope)).toBe(0);
  });
});
