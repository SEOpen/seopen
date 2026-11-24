/**
 * Applies new drizzle/ migrations and exits. compose.yaml runs it once before the web app and the
 * worker start, so neither meets a database without its tables. Safe beside a worker started with
 * MIGRATE_ON_START=1: both take the same lock (src/db/migrate.ts), and the second finds nothing to do.
 *
 *   pnpm db:migrate:start      # with DATABASE_URL in the environment or .env.local
 */
import { migrateOnce } from "@/db/migrate";

migrateOnce()
  .then(() => {
    console.log("[migrate] migrations applied");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("[migrate] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
