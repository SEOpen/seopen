// Postgres error helpers. Pure, so they are unit tested without a database.

/** SQLSTATE for unique_violation. */
export const UNIQUE_VIOLATION = "23505";

/** SQLSTATE for undefined_table, also raised when the table's schema doesn't exist. */
export const UNDEFINED_TABLE = "42P01";

interface PgErrorLike {
  code?: unknown;
  constraint_name?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

/**
 * True when `e` (or an error in its `cause` chain; Drizzle wraps driver errors
 * in DrizzleQueryError) is a Postgres unique violation, optionally on `constraint`.
 */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const err = cur as PgErrorLike;
    if (err.code === UNIQUE_VIOLATION) {
      if (!constraint) return true;
      // postgres.js reports `constraint_name`, node-postgres `constraint`.
      const name = err.constraint_name ?? err.constraint;
      return name === undefined || name === constraint;
    }
    cur = err.cause;
  }
  return false;
}

/** True when `e` (or an error in its `cause` chain) is Postgres saying a table doesn't exist. */
export function isUndefinedTable(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const err = cur as PgErrorLike;
    if (err.code === UNDEFINED_TABLE) return true;
    cur = err.cause;
  }
  return false;
}
