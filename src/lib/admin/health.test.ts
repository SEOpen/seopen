import { DrizzleQueryError } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** failedJobs on a stand-in database whose one query fails the way Drizzle and postgres.js fail. */
const execute = vi.hoisted(() => ({ error: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({
  db: {
    execute: async () => {
      if (execute.error) throw execute.error;
      return [];
    },
  },
}));

const { failedJobs } = await import("./health");

const queryError = (message: string, code: string) => new DrizzleQueryError("select ... from pgboss.job j", [], Object.assign(new Error(message), { code }));

beforeEach(() => {
  execute.error = null;
});

describe("failedJobs", () => {
  it("reads no failed jobs when pgboss.job doesn't exist yet", async () => {
    execute.error = queryError('relation "pgboss.job" does not exist', "42P01");
    await expect(failedJobs()).resolves.toEqual([]);
  });

  it("lets any other query failure surface instead of reading as no failed jobs", async () => {
    execute.error = queryError("canceling statement due to statement timeout", "57014");
    await expect(failedJobs()).rejects.toThrow(DrizzleQueryError);
  });

  it("lets a connection failure surface", async () => {
    execute.error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    await expect(failedJobs()).rejects.toThrow("ECONNREFUSED");
  });
});
