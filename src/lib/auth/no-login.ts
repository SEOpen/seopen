/**
 * No-login mode: a copy running on your own machine opens straight into the app, signed in as its
 * owner, with no password. It is on only when SEOPEN_NO_LOGIN=1 (the local .env.example sets it)
 * and every check below says the request came from this machine. Anything that looks like a server
 * (a public address in the settings, a reverse proxy, a visitor from another address) turns it off,
 * and the copy asks for a password as before. docs/self-hosting.md explains it for people, and
 * AGENTS.md for coding agents.
 *
 * No Better Auth import, so src/proxy.ts can read it on every request.
 */
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";

export const NO_LOGIN_ENV = "SEOPEN_NO_LOGIN";

/** The account no-login mode signs in when the owner workspace has no owner yet. */
export const LOCAL_OWNER_EMAIL = "owner@seopen.localhost";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

type Env = Record<string, string | undefined>;

/** Whether an address is this machine: 127.0.0.0/8, ::1, or 127.x written as IPv6. */
export function isLoopbackAddress(ip: string): boolean {
  const a = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  if (net.isIPv4(v4)) return v4.startsWith("127.");
  return a === "::1" || a === "0:0:0:0:0:0:0:1";
}

/**
 * Inside a Docker container, a browser on the host reaches a port published on 127.0.0.1 through
 * the container's default gateway, so that address counts as this machine too. Traffic from
 * anywhere else keeps its own address. Null outside a container or off Linux.
 */
export function dockerGateway(): string | null {
  try {
    if (!existsSync("/.dockerenv")) return null;
    return gatewayFromRouteTable(readFileSync("/proc/net/route", "utf8"));
  } catch {
    return null;
  }
}

/** The default route's gateway from /proc/net/route, whose addresses are little-endian hex. */
export function gatewayFromRouteTable(table: string): string | null {
  for (const line of table.split("\n").slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== "00000000" || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway)) continue;
    const bytes = gateway.match(/../g)!.map((b) => parseInt(b, 16)).reverse();
    return bytes.join(".");
  }
  return null;
}

/**
 * Why no-login mode is off for this request, or null when it's on. The reasons are written for the
 * person running the copy: the endpoint shows them, and docs/self-hosting.md lists the same checks.
 */
export function noLoginRefusal(headers: Headers, env: Env = process.env, gateway: string | null = dockerGateway()): string | null {
  if (env[NO_LOGIN_ENV] !== "1") return `${NO_LOGIN_ENV} isn't set to 1`;
  // The hosted service, or a copy set up to be reached at a public address.
  if (env.VERCEL || env.SEOPEN_DEPLOY_ENV || env.SEOPEN_APP_HOST) return "this copy is set up as a hosted service";
  if (env.SEOPEN_SITE_HOST) return "SEOPEN_SITE_HOST gives this copy a public address";
  if (env.BETTER_AUTH_URL) {
    let host = "";
    try {
      host = new URL(env.BETTER_AUTH_URL).hostname;
    } catch {
      return "BETTER_AUTH_URL isn't a valid address";
    }
    if (!LOOPBACK_HOSTS.has(host)) return "BETTER_AUTH_URL gives this copy a public address";
  }
  if (env.SEOPEN_TRUST_PROXY) return "SEOPEN_TRUST_PROXY says a reverse proxy is in front of this copy";

  // The address the browser asked for. A request for a domain name, even one pointing at this machine, is refused.
  let hostname = "";
  try {
    hostname = new URL(`http://${headers.get("host") ?? ""}`).hostname;
  } catch {
    hostname = "";
  }
  if (!LOOPBACK_HOSTS.has(hostname)) return "the page was opened at an address other than 127.0.0.1 or localhost";

  // Proxy headers mean someone else's request may have been passed on.
  if (headers.has("forwarded") || headers.has("cloudfront-viewer-address")) return "the request came through a proxy";
  // Next writes the socket's address into x-forwarded-for when nothing in front of it did (base-server.js),
  // so the header is there on every direct request, and a proxy's own value wins over it.
  const forwarded = headers.get("x-forwarded-for");
  const addresses = [...(forwarded ? forwarded.split(",") : []), ...(headers.get("x-real-ip") ? [headers.get("x-real-ip")!] : [])].map((a) => a.trim());
  if (addresses.length === 0) return "the visitor's address is unknown";
  const local = (a: string) => isLoopbackAddress(a) || (gateway !== null && a.replace(/^::ffff:/, "") === gateway);
  if (!addresses.every(local)) return "the request came from another machine";
  return null;
}

export function noLoginAllowed(headers: Headers, env: Env = process.env, gateway: string | null = dockerGateway()): boolean {
  return noLoginRefusal(headers, env, gateway) === null;
}
