import { readFileSync } from "node:fs";

/**
 * TLS options for managed Postgres. DATABASE_CA_CERT holds the provider's CA certificate,
 * either the PEM text itself or a path to the file.
 * Unset means a local database without TLS.
 */
export function dbSsl(): { ca: string; rejectUnauthorized: true } | undefined {
  const value = process.env.DATABASE_CA_CERT?.trim();
  if (!value) return undefined;
  const ca = value.startsWith("-----BEGIN") ? value.replace(/\\n/g, "\n") : readFileSync(value, "utf8");
  return { ca, rejectUnauthorized: true };
}
