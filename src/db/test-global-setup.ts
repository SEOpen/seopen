import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { isTestDatabaseUrl } from "./test-database";

/**
 * Runs once per test run, before any test file starts (`globalSetup` in vitest.config). It creates
 * the test database when it doesn't exist yet (a new worktree gets its own, src/db/test-database.ts),
 * then zeroes this month's `platform_usage` row in it: every workspace shares that row, so no test
 * can seed its own, and without this it grows run after run until the platform cap refuses paid calls.
 * Then it retires recap and alert rows earlier runs left (`retireLeftovers`).
 *
 * It isn't in testDb(), which runs once per file: a reset while other files are running hands back
 * room that the platform cap test in usage.db.test.ts has already counted. It sets the row rather
 * than deleting it, because a missing row is seeded from api_ledger, which nothing truncates.
 */
export default async function setup({ config }: TestProject) {
  // From the config, not process.env: a DATABASE_URL in the shell could be a real database.
  const url = config.env.DATABASE_URL;
  if (!isTestDatabaseUrl(url)) throw new Error("Database tests only run against seopen_test.");
  if (!(await ensureDatabase(url))) return;
  const client = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    // A brand new database has no table yet: testDb() builds the schema, and the row starts at zero.
    const [{ exists }] = await client<{ exists: boolean }[]>`select to_regclass('public.platform_usage') is not null as exists`;
    if (exists) {
      await client`
        insert into platform_usage (month, spent_usd, reserved_usd) values (date_trunc('month', now())::date, 0, 0)
        on conflict (month) do update set spent_usd = 0, reserved_usd = 0, updated_at = now()`;
    }
    await retireLeftovers(client);
  } finally {
    await client.end({ timeout: 1 });
  }
}

/**
 * The weekly recap and the alert emails' hourly pass read every workspace in the database, not one
 * test's, and nothing deletes test rows. So people still opted in to the recap and alerts still
 * waiting for an email, left by earlier runs (a run stopped before afterEach, or a test that leaves
 * an alert unsent on purpose), pile up until those tests take over 5 seconds under load. This turns them
 * off. Only rows whose account or project is over an hour old: a run on the same database that's
 * going on now keeps its own.
 */
async function retireLeftovers(client: postgres.Sql): Promise<void> {
  const [{ ready }] = await client<{ ready: boolean }[]>`
    select to_regclass('public.alerts') is not null and to_regclass('public.users') is not null
      and exists (select 1 from information_schema.columns where table_name = 'users' and column_name = 'weekly_recap') as ready`;
  if (!ready) return;
  await client`update users set weekly_recap = false where weekly_recap and created_at < now() - interval '1 hour'`;
  await client`
    update alerts set resolved_at = now()
    where resolved_at is null and send_id is null
      and project_id in (select id from projects where created_at < now() - interval '1 hour')`;
}

/**
 * True when the database is there (made now if it was missing); false when Postgres isn't reachable,
 * so the database tests skip. It asks pg_database first rather than catching "database does not
 * exist": a Postgres query error thrown in globalSetup crashes Vite's stack trace mapping.
 */
async function ensureDatabase(url: string): Promise<boolean> {
  const name = new URL(url).pathname.slice(1);
  const admin = postgres(Object.assign(new URL(url), { pathname: "/postgres" }).toString(), { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    try {
      await admin`select 1`;
    } catch {
      return false;
    }
    const [found] = await admin<{ one: number }[]>`select 1 as one from pg_database where datname = ${name}`;
    // The name passed isTestDatabaseUrl, so it is only lowercase letters, digits and underscores.
    if (!found) await admin.unsafe(`create database ${name}`);
    return true;
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {});
  }
}
