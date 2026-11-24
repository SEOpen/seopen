/**
 * The visitor's address, read only from headers the proxy in front of the app writes. Core, not
 * cloud: sign-in's rate limits need it (src/app/api/auth/[...all]/route.ts) as much as the free
 * tools' quotas do (src/modules/tools/limits.ts).
 */
import net from "node:net";

/**
 * Whether the request's forwarded-address headers can be believed: on Vercel the platform sets
 * them, and a self-hosted copy sets SEOPEN_TRUST_PROXY=1 when it runs behind a reverse proxy that
 * does. Without a proxy (compose.yaml publishes the port straight to the internet) a visitor could
 * write their own and get a fresh quota on every request. On AWS it is `cloudfront` (behindCloudFront).
 */
export function trustsProxyHeaders(): boolean {
  return !!process.env.VERCEL || process.env.SEOPEN_TRUST_PROXY === "1" || behindCloudFront();
}

/**
 * SEOPEN_TRUST_PROXY=cloudfront (the AWS stack): CloudFront writes CloudFront-Viewer-Address, over
 * anything the visitor sent, and the load balancer only admits CloudFront. X-Real-IP is off limits
 * to CloudFront Functions and X-Forwarded-For ends in CloudFront's own address, so in this mode
 * neither is read: a missing header means no address, never a fallback a visitor could write.
 */
function behindCloudFront(): boolean {
  return process.env.SEOPEN_TRUST_PROXY === "cloudfront";
}

/** "198.51.100.10:46532" or "2001:db8::1:46532": the address, without CloudFront's port. */
function viewerAddress(value: string | null): string {
  const v = value?.trim() ?? "";
  const port = v.lastIndexOf(":");
  return port > 0 ? v.slice(0, port) : "";
}

/**
 * The visitor's address as the proxy in front reports it: x-real-ip, else the last x-forwarded-for
 * entry, the one that proxy appended (earlier entries are whatever the client sent). Null when the
 * headers can't be trusted, are missing, or don't hold an address.
 */
export function clientAddress(headers: Headers, trusted = trustsProxyHeaders()): string | null {
  if (!trusted) return null;
  const raw = behindCloudFront()
    ? viewerAddress(headers.get("cloudfront-viewer-address"))
    : (headers.get("x-real-ip") ?? headers.get("x-forwarded-for")?.split(",").at(-1) ?? "");
  const ip = raw.trim();
  return net.isIPv4(ip) || net.isIPv6(ip) ? ip : null;
}

/**
 * The key the free tools count a visitor by: their address, or "local" when there isn't one. An
 * IPv6 visitor is keyed by their /56, a typical home's whole allocation, so rotating through it gets
 * no new quota; a /48 can hold hundreds of homes.
 */
export function clientIp(headers: Headers, trusted = trustsProxyHeaders()): string {
  const ip = clientAddress(headers, trusted);
  if (!ip) return "local";
  if (net.isIPv6(ip)) {
    const full = (ip.includes("::") ? expandV6(ip) : ip.split(":")).map((g) => parseInt(g || "0", 16));
    const hex = (n: number) => n.toString(16);
    return `${hex(full[0])}:${hex(full[1])}:${hex(full[2])}:${hex(full[3] & 0xff00)}::/56`;
  }
  return ip;
}

function expandV6(ip: string): string[] {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  return [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
}

/**
 * The header Better Auth reads the visitor's address from (`advanced.ipAddress` in
 * src/lib/auth/index.ts). The proxy sets it on every /api/auth request (src/proxy.ts), from
 * clientAddress, after deleting whatever the visitor sent under the same name, so it can't be forged.
 * CloudFront-Viewer-Address can't be handed to Better Auth directly: it carries a port, and Better
 * Auth refuses anything but a bare IP.
 */
export const CLIENT_IP_HEADER = "x-seopen-client-ip";

/**
 * A copy of the request headers with CLIENT_IP_HEADER set from trusted headers, or removed when
 * there's no address. Only the headers are copied: the proxy hands them on with
 * NextResponse.next({ request: { headers } }). Copying the Request itself (new Request(request))
 * broke every auth call in production, since Next's request isn't a plain Request there.
 */
export function withClientIpHeader(source: Headers, trusted = trustsProxyHeaders()): Headers {
  const headers = new Headers(source);
  headers.delete(CLIENT_IP_HEADER);
  const ip = clientAddress(source, trusted);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return headers;
}
