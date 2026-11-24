import { describe, expect, it } from "vitest";
import { jobErrorLine } from "./job-error";

// The shape of Admin Health's Nov 3 local.schedule failure: Drizzle's text, with the SQL and its params.
const drizzle = [
  'Failed query: select "id" from "local_checks" where ("local_checks"."workspace_id" = $1 and "local_checks"."business_id" = $2 and "local_checks"."status" in ($3, $4, $5) and "local_checks"."created_at" > $6) limit $7',
  "params: 1,1,posting,pending,done,Tue Oct 27 2026 09:30:00 GMT+0000 (Coordinated Universal Time),1",
].join("\n");

describe("jobErrorLine", () => {
  it("names the table and keeps the database's own error, without the SQL or params", () => {
    const line = jobErrorLine({ message: drizzle, cause: 'invalid input syntax for type timestamp with time zone: "Tue Oct 27 2026"' });
    expect(line).toBe('A query on local_checks failed: invalid input syntax for type timestamp with time zone: "Tue Oct 27 2026"');
    expect(line).not.toMatch(/Failed query|params|\$1/);
  });

  it("still leaves the SQL out when no cause was stored", () => {
    expect(jobErrorLine({ message: drizzle, cause: null })).toBe("A query on local_checks failed");
    expect(jobErrorLine({ message: "Failed query: select 1\nparams: ", cause: null })).toBe("A database query failed");
  });

  it("reads the table from an insert, update or delete", () => {
    expect(jobErrorLine({ message: 'Failed query: insert into "rank_tasks" ("id") values ($1)\nparams: x', cause: "duplicate key" })).toBe("A query on rank_tasks failed: duplicate key");
    expect(jobErrorLine({ message: 'Failed query: update "rank_runs" set "status" = $1\nparams: done', cause: null })).toBe("A query on rank_runs failed");
    expect(jobErrorLine({ message: 'Failed query: delete from "local_points" where "id" = $1\nparams: 4', cause: null })).toBe("A query on local_points failed");
  });

  it("keeps a handler's own words ahead of a query error it wrapped", () => {
    expect(jobErrorLine({ message: `rank run 12: ${drizzle}`, cause: null })).toBe("rank run 12: A query on local_checks failed");
  });

  it("shows other errors as their first line", () => {
    expect(jobErrorLine({ message: "DataForSEO HTTP 500 on serp/google/organic/task_post", cause: null })).toBe("DataForSEO HTTP 500 on serp/google/organic/task_post");
    expect(jobErrorLine({ message: "  \nboom\n    at handler (worker.ts:1)", cause: null })).toBe("boom");
  });

  it("falls back to the cause, or nothing", () => {
    expect(jobErrorLine({ message: null, cause: "connect ECONNREFUSED" })).toBe("connect ECONNREFUSED");
    expect(jobErrorLine({ message: "", cause: null })).toBeNull();
  });
});
