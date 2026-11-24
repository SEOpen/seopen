import { FetchRefusedError, normalizeHost, safeFetch } from "@/lib/web/fetch";
import { UMAMI_CLOUD_API, UmamiUnreachableError } from "./types";

/** Long enough for a real query, and short enough that a stuck server can't hold up the Analytics page. */
export const TIMEOUT_MS = 30_000;
/** A website list or a day's entry pages is far smaller. Past this the response is refused, not parsed. */
const MAX_BYTES = 5_000_000;

/** Umami Cloud's own hosts, which connect as Cloud rather than as a self-hosted server. */
const CLOUD_HOSTS = new Set(["umami.is", "cloud.umami.is", "api.umami.is"]);

export type ServerCheck = { ok: true; baseUrl: string | null } | { ok: false; error: string };

/**
 * A self-hosted Umami address as SEOpen stores it: "https://stats.example.com" or with the path the
 * server is mounted under, without a trailing "/api". Blank means Umami Cloud. Only https on the
 * default port and a public hostname: the credential travels to it, and requests go through
 * `safeFetch`, which checks each address again after DNS.
 */
export function normalizeUmamiServer(input: string): ServerCheck {
  const raw = input.trim();
  if (!raw) return { ok: true, baseUrl: null };
  if (raw.length > 300) return { ok: false, error: "That Umami address is too long." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That isn't a web address. Enter your Umami server's address, like https://stats.example.com." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Your Umami server's address has to start with https://, so the key isn't sent in the clear." };
  if (url.username || url.password) return { ok: false, error: "Leave the login out of the address. Use the fields below for it." };
  if (url.port && url.port !== "443") return { ok: false, error: "SEOpen only connects on the standard https port. Put your Umami server behind one, then connect it here." };
  const host = normalizeHost(url.hostname);
  if (!host) return { ok: false, error: "That address isn't a public website, so SEOpen can't reach it." };
  if (CLOUD_HOSTS.has(host)) return { ok: true, baseUrl: null };
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return { ok: true, baseUrl: `https://${host}${path}` };
}

/** Where the API lives for a connection: Umami Cloud, or a self-hosted server's "/api". */
export const apiRoot = (baseUrl: string | null) => (baseUrl ? `${baseUrl}/api` : UMAMI_CLOUD_API);

export interface UmamiRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}
export interface UmamiResponse {
  status: number;
  body: string;
}
/** One HTTP exchange with Umami. Tests pass a fake. */
export type UmamiTransport = (req: UmamiRequest) => Promise<UmamiResponse>;

/** Umami Cloud: a fixed address, so plain fetch, and no redirect is followed with the key. */
export function cloudTransport(fetchImpl: typeof fetch = fetch): UmamiTransport {
  return async ({ url, method, headers, body }) => {
    if (!url.startsWith(`${UMAMI_CLOUD_API}/`)) throw new Error("Umami Cloud requests go to its API only");
    const res = await fetchImpl(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, body: await res.text() };
  };
}

/**
 * A self-hosted server, at an address the customer typed: through `safeFetch`, which refuses
 * private and reserved addresses after DNS (so a rebinding answer can't point it inside SEOpen's
 * network), follows no redirect when there's a credential, caps the body and holds one deadline.
 */
export const selfHostedTransport: UmamiTransport = async ({ url, method, headers, body }) => {
  try {
    const res = await safeFetch(url, { method, headers, body, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    if (res.truncated) throw new UmamiUnreachableError("Your Umami server sent more than SEOpen reads in one answer.");
    return { status: res.status, body: res.body };
  } catch (err) {
    if (err instanceof UmamiUnreachableError) throw err;
    throw new UmamiUnreachableError(`SEOpen couldn't reach your Umami server. ${unreachable(err)}`);
  }
};

/** Why a self-hosted server couldn't be reached, in words for the customer. */
function unreachable(err: unknown): string {
  if (err instanceof FetchRefusedError) return `${err.message}.`;
  const code = (err as { code?: string })?.code;
  if (code === "EPRIVATE") return "Its address points at a private network, so SEOpen won't connect to it.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Its domain isn't in DNS.";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return `It didn't answer within ${TIMEOUT_MS / 1000} seconds.`;
  if (code === "ECONNREFUSED") return "It refused the connection.";
  if (code === "ECONNRESET") return "It closed the connection.";
  if (typeof code === "string" && /CERT|SSL|TLS/i.test(code)) return "Its HTTPS certificate isn't valid.";
  return "It didn't answer.";
}

export const transportFor = (baseUrl: string | null): UmamiTransport => (baseUrl ? selfHostedTransport : cloudTransport());
