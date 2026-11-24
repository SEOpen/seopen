/** An email address as sign-up compares them, so one inbox can't pass for two. */

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** Lowercased, `+tags` removed everywhere, and Gmail's dots removed (googlemail.com is gmail.com). */
export function normalizeEmail(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at <= 0) return null;
  let local = email.trim().toLowerCase().slice(0, at);
  let domain = email.trim().toLowerCase().slice(at + 1);
  local = local.split("+")[0];
  if (GMAIL.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\./g, "");
  }
  return local && domain ? `${local}@${domain}` : null;
}
