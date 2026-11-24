/**
 * Post sign-in destinations come from the URL, so only same-site relative paths are allowed:
 * one leading slash, no protocol-relative `//` or `/\`, no control characters, and never back to
 * an auth page. Anything else falls back to the dashboard.
 */
const AUTH_PAGES = ["/login", "/sign-in", "/sign-up", "/forgot-password", "/reset-password", "/set-password", "/verify-email"];

export function safeCallback(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\\]/.test(raw)) return fallback;
  if (AUTH_PAGES.some((p) => raw === p || raw.startsWith(`${p}?`) || raw.startsWith(`${p}/`))) return fallback;
  return raw;
}

/** Pages anyone may open without a session. */
export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.includes(pathname) || pathname.startsWith("/api/auth/");
}
