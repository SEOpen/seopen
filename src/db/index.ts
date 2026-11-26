import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { poolMax } from "./pool";
import { dbSsl } from "./ssl";

declare global {
  var __seopenSql: ReturnType<typeof postgres> | undefined;
}

// One pool per process; dev hot reloads reuse it instead of leaking connections.
// Its size is poolMax (./pool.ts): 5 unless DATABASE_POOL_MAX says otherwise. No prepared statements,
// so the app also works through PgBouncer in transaction mode, which can't keep them.
// Idle connections close after 20 seconds, so a serverless instance that sat frozen while the app was
// left open opens fresh ones instead of finding dead ones. A connect gives up after 10 seconds,
// not the default 30: a stuck connect (CONNECT_TIMEOUT in production logs, Nov 12) shouldn't hold
// a page that long.
const sql = (globalThis.__seopenSql ??= postgres(process.env.DATABASE_URL!, { max: poolMax(), prepare: false, ssl: dbSsl(), idle_timeout: 20, connect_timeout: 10 }));

export const db = drizzle(sql, { schema, casing: "snake_case" });
export type DB = typeof db;
export { schema };
