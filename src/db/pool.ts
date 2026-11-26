/**
 * How many Postgres connections one process may hold (src/db/index.ts). Every page, route and job
 * in the process shares them, and a request that runs more queries at once than there are
 * connections waits for one, as does every other request meanwhile. DATABASE_POOL_MAX raises it
 * for a long-running server whose database has room (docs/self-hosting.md). Unset, or not a whole
 * number from 1 to 100, it is 5, which suits a small or shared database and serverless hosts.
 */
export const DEFAULT_POOL_MAX = 5;

export function poolMax(value = process.env.DATABASE_POOL_MAX): number {
  const text = value?.trim() ?? "";
  const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  return n >= 1 && n <= 100 ? n : DEFAULT_POOL_MAX;
}
