import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./index";
import { GLOBAL_TABLES } from "./core";

// Columns declared without a name carry their camelCase key; the database uses snake_case (see src/db).
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const tables = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => v instanceof PgTable)
  .map((t) => getTableConfig(t));

describe("tenancy schema", () => {
  it("puts a NOT NULL workspace_id on every table that isn't global on purpose", () => {
    const missing = tables
      .filter((t) => !(GLOBAL_TABLES as readonly string[]).includes(t.name))
      .filter((t) => !t.columns.some((c) => snake(c.name) === "workspace_id" && c.notNull))
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("holds Plausible's connection to one workspace, with its row going when the workspace does", () => {
    const table = tables.find((t) => t.name === "plausible_accounts")!;
    expect((GLOBAL_TABLES as readonly string[]).includes(table.name)).toBe(false);
    expect(table.columns.find((c) => c.name === "workspaceId" || c.name === "workspace_id")?.notNull).toBe(true);
    expect(table.foreignKeys.map((fk) => [getTableConfig(fk.reference().foreignTable).name, fk.onDelete])).toEqual([["workspaces", "cascade"]]);
  });

  it("holds Umami's connection to one workspace, with its row going when the workspace does", () => {
    const table = tables.find((t) => t.name === "umami_accounts")!;
    expect((GLOBAL_TABLES as readonly string[]).includes(table.name)).toBe(false);
    expect(table.columns.find((c) => c.name === "workspaceId" || c.name === "workspace_id")?.notNull).toBe(true);
    expect(table.foreignKeys.map((fk) => [getTableConfig(fk.reference().foreignTable).name, fk.onDelete])).toEqual([["workspaces", "cascade"]]);
  });

  // Deleting a workspace removes the workspaces row and lets the cascade take the rest
  // (src/lib/workspace/delete.ts), as the privacy page promises. trial_claims outlives it on purpose.
  // A table goes when a cascading foreign key on its workspace_id reaches workspaces, directly or
  // through a parent that goes (audit_pages through audit_crawls, say).
  it("deletes every tenant table's rows when the workspace goes", () => {
    const goes = new Set(["workspaces"]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of tables) {
        if (goes.has(t.name)) continue;
        const cascades = t.foreignKeys.some((fk) => {
          const ref = fk.reference();
          return fk.onDelete === "cascade" && goes.has(getTableConfig(ref.foreignTable).name) && ref.columns.some((c) => snake(c.name) === "workspace_id");
        });
        if (!cascades) continue;
        goes.add(t.name);
        grew = true;
      }
    }
    const kept = tables
      .filter((t) => t.columns.some((c) => snake(c.name) === "workspace_id") && t.name !== "trial_claims")
      .filter((t) => !goes.has(t.name))
      .map((t) => t.name);
    expect(kept).toEqual([]);
  });

  it("lists only real tables as global", () => {
    const names = new Set(tables.map((t) => t.name));
    expect(GLOBAL_TABLES.filter((n) => !names.has(n))).toEqual([]);
  });

  // api_ledger is the exception: spend history outlives a deleted project, so its project_id is a
  // label with no foreign key (the row still belongs to its workspace).
  it("ties every project-owned table to its project within the same workspace", () => {
    const loose = tables
      .filter((t) => t.columns.some((c) => snake(c.name) === "project_id") && !["projects", "api_ledger"].includes(t.name))
      .filter((t) => !t.foreignKeys.some((fk) => {
        const ref = fk.reference();
        const cols = ref.columns.map((c) => snake(c.name));
        return getTableConfig(ref.foreignTable).name === "projects" && cols.includes("workspace_id") && cols.includes("project_id");
      }))
      .map((t) => t.name);
    expect(loose).toEqual([]);
  });

  it("indexes workspace_id on every tenant table", () => {
    const unindexed = tables
      .filter((t) => t.columns.some((c) => snake(c.name) === "workspace_id"))
      .filter((t) => {
        const first = [
          ...t.indexes.map((i) => i.config.columns[0]),
          ...t.primaryKeys.map((pk) => pk.columns[0]),
          ...t.uniqueConstraints.map((u) => u.columns[0]),
        ].map((c) => (c && "name" in c && typeof c.name === "string" ? snake(c.name) : null));
        const pk = t.columns.find((c) => c.primary)?.name;
        const pkCol = pk ? snake(pk) : null;
        return !first.includes("workspace_id") && pkCol !== "workspace_id";
      })
      .map((t) => t.name);
    expect(unindexed).toEqual([]);
  });
});
