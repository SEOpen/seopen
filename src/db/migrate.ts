import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dbSsl } from "./ssl";

/** Any fixed number: the key two workers' migration runs share in `pg_advisory_lock`. */
const MIGRATION_LOCK = 7_301_034;

/**
 * Applies new drizzle/ migrations, one worker at a time. During a deploy an old and a new worker can
 * start together; the second waits on the lock, then finds nothing left to apply. A session lock
 * needs one connection for the lock, the migration and the unlock, so this uses its own client.
 */
export async function migrateOnce() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, ssl: dbSsl(), onnotice: () => {} });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
