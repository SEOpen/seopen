import { plainNextStep, unknownFailureNextStep } from "@/lib/dataforseo/failure-copy";

/**
 * Whether a Search Console property covers a URL. "sc-domain:x.com" covers x.com and its subdomains
 * on http and https; "https://www.x.com/blog/" covers only URLs starting with exactly that.
 */
export function urlInProperty(url: string, property: string): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    if (!property.startsWith("sc-domain:")) return target.href.startsWith(new URL(property).href);
    const domain = new URL(`https://${property.slice("sc-domain:".length)}`).hostname;
    return target.hostname === domain || target.hostname.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

const httpStatus = (err: unknown) => (err as { status?: number; response?: { status?: number } } | null)?.response?.status ?? (err as { status?: number } | null)?.status;

/** Node's and the fetch client's network failures, directly or as the cause of a wrapper. */
function isNetworkError(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    const { code } = e as { code?: unknown };
    if (typeof code === "string" && /^(E[A-Z_]+|UND_ERR_\w+)$/.test(code)) return true;
    if (/fetch failed|socket hang up|network|timed? ?out/i.test(e.message)) return true;
  }
  return false;
}

/** What the form says when an inspection fails. It says to try again only where that could work. */
export function inspectFailureMessage(err: unknown): string {
  const status = httpStatus(err);
  if (status ? status >= 500 : isNetworkError(err)) return plainNextStep(err, "Google didn't answer that inspection. Try again in a minute.");
  if (status) return plainNextStep(err, "Google wouldn't inspect that URL. Check that the address is right.");
  return plainNextStep(err, `That inspection didn't finish. ${unknownFailureNextStep()}`);
}
