/**
 * The largest request body the proxy (src/proxy.ts) takes, in bytes. Next buffers each body the proxy
 * sees in memory, before any session, signature or rate check, up to `experimental.proxyClientMaxBodySize`
 * (next.config.ts), which this sets. Over that, Next hands on only the first part of the body and
 * goes on as if nothing were wrong, so the proxy refuses a request that declares a longer body.
 *
 * 1 MiB is Next's own limit on a Server Action body, and the largest body the app takes: MCP tool
 * calls, sign-in, analytics events and webhooks are all far smaller.
 */
export const PROXY_BODY_LIMIT_BYTES = 1024 * 1024;

/** Whether a request's Content-Length says its body is longer than the proxy takes. */
export function declaresTooLargeBody(headers: Headers): boolean {
  const length = Number(headers.get("content-length"));
  return Number.isFinite(length) && length > PROXY_BODY_LIMIT_BYTES;
}
