import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isUndefinedTable } from "./db-errors";

describe("isUndefinedTable", () => {
  const missing = Object.assign(new Error('relation "pgboss.job" does not exist'), { code: "42P01" });

  it("finds the driver error inside Drizzle's wrapper", () => {
    expect(isUndefinedTable(missing)).toBe(true);
    expect(isUndefinedTable(new DrizzleQueryError("select 1 from pgboss.job", [], missing))).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isUndefinedTable(new DrizzleQueryError("select 1", [], Object.assign(new Error("timeout"), { code: "57014" })))).toBe(false);
    expect(isUndefinedTable(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isUndefinedTable(new Error("boom"))).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});
