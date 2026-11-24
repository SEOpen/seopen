/**
 * One line for a failed job's stored error on the admin pages. pg-boss keeps the thrown error as JSON
 * (serialize-error), so a Drizzle query failure arrives as "Failed query: <the SQL>\nparams: <values>"
 * with the database's own error under `cause`. The line names the table and keeps that cause, and
 * leaves the SQL and its parameters out.
 */
export interface StoredJobError {
  message: string | null;
  /** The wrapped error's message, when the thrown error had a `cause`. */
  cause: string | null;
}

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

const DRIZZLE_PREFIX = "Failed query: ";

export function jobErrorLine({ message, cause }: StoredJobError): string | null {
  const reason = cause ? firstLine(cause) : "";
  const text = message?.trim() ?? "";
  if (!text) return reason || null;
  const at = text.indexOf(DRIZZLE_PREFIX);
  if (at === -1) return firstLine(text);
  // A handler may have wrapped the query error's text in its own ("rank run 12: Failed query: …").
  const before = text.slice(0, at);
  const table = text.slice(at).match(/\b(?:from|into|update|join)\s+"([^"]+)"/i)?.[1];
  const what = `${table ? `A query on ${table}` : "A database query"} failed`;
  return `${before}${what}${reason ? `: ${reason}` : ""}`;
}
