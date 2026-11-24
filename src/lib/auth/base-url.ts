import { splitHosts } from "@/lib/hosts";

/**
 * Where the app lives: BETTER_AUTH_URL if set, else the app host once hosts are split, else local dev.
 * Its own file so the proxy can read it without loading Better Auth.
 */
export function authBaseUrl(): string {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL;
  const hosts = splitHosts();
  return hosts ? `https://${hosts.app}` : "http://127.0.0.1:4100";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Sign-in trusts one origin, the base URL, and its cookies belong to that host. A copy that runs at
 * http://127.0.0.1:4100 is just as often opened as http://localhost:4100, where sign-in would fail
 * with an untrusted origin. When the base URL is a loopback address, this sends a request for
 * another loopback name on the same port to the base URL instead. `null` when nothing should move.
 */
export function loopbackRedirect(url: URL, base: string = authBaseUrl()): string | null {
  let target: URL;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  if (!LOOPBACK.has(target.hostname) || !LOOPBACK.has(url.hostname)) return null;
  if (url.hostname === target.hostname || url.port !== target.port || url.protocol !== target.protocol) return null;
  return `${target.origin}${url.pathname}${url.search}`;
}
