import { readFileSync } from "node:fs";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { db } from "./index";
import { isTestDatabaseUrl } from "./test-database";

/**
 * Database-backed tests (`*.db.test.ts`) run against the local `seopen_test` database, or a worktree
 * of its own (vitest.config points DATABASE_URL there, src/db/test-database.ts) and skip when it isn't reachable. The first file to get here brings
 * the schema up to date under an advisory lock: when the newest migration isn't applied yet it
 * drops everything and migrates from scratch, so a test database never carries an old schema.
 * Rows are never truncated; every test seeds its own workspaces and projects, so files can run
 * in parallel. The one exception is the platform's row for the month, which no test can seed for
 * itself: test-global-setup.ts zeroes it once, before the files start.
 */
const URL = process.env.DATABASE_URL ?? "postgres://localhost:5432/seopen_test";
const LOCK = 7_340_301;

let ready: Promise<boolean> | null = null;

function latestMigration(): number {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { when: number }[] };
  return Math.max(...journal.entries.map((e) => e.when));
}

/** True when the test database is ready; false (skip the tests) when Postgres isn't reachable. */
export function testDb(): Promise<boolean> {
  if (!isTestDatabaseUrl(URL)) throw new Error("Database tests only run against seopen_test.");
  ready ??= (async () => {
    const client = postgres(URL, { max: 1, connect_timeout: 2, onnotice: () => {} });
    try {
      await client`select 1`;
    } catch {
      await client.end({ timeout: 1 }).catch(() => {});
      return false;
    }
    try {
      await client`select pg_advisory_lock(${LOCK})`;
      // Postgres resolves every relation in a statement up front, so check the table exists first.
      const [{ exists }] = await client<{ exists: boolean }[]>`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`;
      const [row] = exists ? await client<{ at: string | null }[]>`select max(created_at)::text as at from drizzle.__drizzle_migrations` : [];
      if (Number(row?.at ?? 0) !== latestMigration()) {
        await client.unsafe("drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; drop schema public cascade; create schema public;");
        await migrate(db, { migrationsFolder: "drizzle" });
      }
    } finally {
      await client`select pg_advisory_unlock(${LOCK})`.catch(() => {});
      await client.end({ timeout: 1 });
    }
    return true;
  })();
  return ready;
}
