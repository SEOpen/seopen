import domains from "disposable-email-domains";

/**
 * Throwaway email domains (the `disposable-email-domains` list, about 120k entries), refused at
 * sign-up so a trial needs a real inbox. Subdomains of a listed domain count too.
 */
const DISPOSABLE: ReadonlySet<string> = new Set((domains as string[]).map((d) => d.toLowerCase()));

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const host = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  }
  return false;
}
