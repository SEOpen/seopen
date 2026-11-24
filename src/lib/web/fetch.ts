/**
 * Fetching a visitor's site for the free tools. The address comes from the public internet, so
 * this guards against server-side request forgery: only http(s) on the default ports, only public
 * hostnames, and every connection (redirects included) goes to an address checked after DNS
 * resolution, through the socket's own lookup, so a rebinding DNS answer can't swap in a private
 * address between the check and the connect. Bodies are capped, and each fetch has one total
 * deadline across its redirects, however slowly the site sends.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { parse as parseDomain } from "tldts";

/**
 * Who a site owner finds behind SEOpenBot in their logs: the copy's own address when it sets one
 * (SEOPEN_SITE_HOST), or else the project's repository, never another copy's site.
 */
function botInfoUrl(): string {
  const host = process.env.SEOPEN_SITE_HOST?.trim().toLowerCase();
  return host ? `https://${host}` : "https://github.com/SEOpen/seopen";
}

export const TOOL_USER_AGENT = `Mozilla/5.0 (compatible; SEOpenBot/1.0; +${botInfoUrl()})`;

/** Real crawler user agents, for the "does your firewall turn AI crawlers away" check. */
export const CRAWLER_USER_AGENTS = {
  GPTBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot",
  ClaudeBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com",
  PerplexityBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
} as const;

/**
 * The search crawlers' user agents, for the site audit's bot fetch test. Firewalls and CDN bot rules
 * match on the product token (Googlebot, OAI-SearchBot), so the token is what matters here. A request
 * from SEOpen with one of these still comes from SEOpen's IP address, not the crawler's, so this
 * tests user-agent rules only.
 */
export const SEARCH_BOT_USER_AGENTS = {
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  "Claude-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)",
  PerplexityBot: CRAWLER_USER_AGENTS.PerplexityBot,
} as const;

export class FetchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefusedError";
  }
}

const PRIVATE = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net4, prefix, "ipv4");
for (const [net6, prefix] of [
  // No ::ffff:0:0/96 here: BlockList would match every IPv4 address against it. Mapped addresses
  // are unwrapped and checked as IPv4 in isPublicAddress.
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) PRIVATE.addSubnet(net6, prefix, "ipv6");

/** An IPv6 address's eight groups, or null when it doesn't parse. The URL parser writes any dotted IPv4 tail as hex. */
function ipv6Groups(address: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head, tail] = host.split("::");
  const groups = (s: string | undefined) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const [left, right] = [groups(head), groups(tail)];
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** True for an address on the public internet (not loopback, private, link-local, reserved...). */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !PRIVATE.check(address, "ipv4");
  if (family === 6) {
    const g = ipv6Groups(address);
    if (!g) return false;
    // IPv4 carried in IPv6 is checked as that IPv4 too, in any spelling: mapped ::ffff:0:0/96,
    // translated ::ffff:0:0:0/96 and IPv4-compatible ::/96 (which holds :: and ::1).
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
    if ((zeros(5) && g[5] === 0xffff) || (zeros(4) && g[4] === 0xffff && g[5] === 0) || zeros(6)) {
      if (PRIVATE.check(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, "ipv4")) return false;
    }
    return !PRIVATE.check(address, "ipv6");
  }
  return false;
}

/**
 * A visitor's site as a bare public hostname: "https://www.Example.com/a" → "www.example.com".
 * Null when it isn't a hostname under a real public suffix (localhost, IPs, intranet names).
 */
export function normalizeHost(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || (url.port && url.port !== "80" && url.port !== "443")) return null;
  const host = url.hostname.replace(/\.$/, "");
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) return null;
  const parsed = parseDomain(host);
  if (!parsed.domain || !parsed.isIcann || parsed.isIp) return null;
  return host;
}

/** The registrable domain of a host: "blog.example.co.uk" → "example.co.uk". */
export function siteDomain(host: string): string {
  return parseDomain(host).domain ?? host;
}

/** The path a visitor typed with their site, or "/". */
export function inputPath(input: string): string {
  const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  try {
    const u = new URL(s);
    return `${u.pathname || "/"}${u.search}`.slice(0, 500);
  } catch {
    return "/";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup for the socket that refuses the whole host if any of its addresses isn't public. */
function guardedLookup(hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback) {
  const all = typeof options === "object" && options?.all === true;
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, all ? [] : "");
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      const refused = Object.assign(new Error(`${hostname} resolves to a private address`), { code: "EPRIVATE" });
      return callback(refused, all ? [] : "");
    }
    if (all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export interface FetchResult {
  /** The final URL after redirects. */
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The body was longer than the cap and was cut. */
  truncated: boolean;
  /** Every URL redirected through, in order. */
  redirects: string[];
  ms: number;
}

export interface FetchOptions {
  userAgent?: string;
  /** Decompressed bytes kept (default 2 MB). */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Stop after the headers (for status-only checks). */
  headOnly?: boolean;
  /** GET unless set. */
  method?: "GET" | "POST";
  /**
   * Sent with the request, over the defaults (an API client's accept and authorization). A request
   * with headers or a body never follows a redirect, so a credential can't be carried to another address.
   */
  headers?: Record<string, string>;
  /** A request body, sent as given. */
  body?: string;
}

/** One HTTP request through the guarded lookup. Doesn't follow redirects. */
type RequestOptions = Required<Omit<FetchOptions, "maxRedirects" | "method" | "headers" | "body">> & Pick<FetchOptions, "method" | "headers" | "body">;

function requestOnce(url: URL, opts: RequestOptions, deadline: number): Promise<Omit<FetchResult, "redirects" | "url" | "ms">> {
  return new Promise((settleOk, settleErr) => {
    const lib = url.protocol === "https:" ? https : http;
    const remaining = Math.max(1, deadline - Date.now());
    let settled = false;
    const resolve = (v: Omit<FetchResult, "redirects" | "url" | "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleOk(v);
    };
    const reject = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleErr(err);
    };
    // The socket's `timeout` only fires on silence, so a site that sends a byte every few seconds
    // would hold the request (and the visitor's tool run) open for good. This is the whole deadline.
    const timer = setTimeout(() => {
      const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      reject(err);
      req.destroy(err);
    }, remaining);
    const req = lib.request(
      url,
      {
        method: opts.method ?? "GET",
        lookup: guardedLookup as unknown as net.LookupFunction,
        headers: {
          "user-agent": opts.userAgent,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en",
          ...opts.headers,
          ...(opts.body === undefined ? {} : { "content-length": String(Buffer.byteLength(opts.body)) }),
        },
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (opts.headOnly || (status >= 300 && status < 400)) {
          res.destroy();
          return resolve({ status, headers: res.headers, body: "", truncated: false });
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip" || encoding === "x-gzip"
            ? res.pipe(zlib.createGunzip())
            : encoding === "br"
              ? res.pipe(zlib.createBrotliDecompress())
              : encoding === "deflate"
                ? res.pipe(zlib.createInflate())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), truncated });
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = opts.maxBytes - size;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room));
            size = opts.maxBytes;
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on("end", () => !truncated && finish());
        stream.on("error", (err) => (truncated ? undefined : reject(err)));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(opts.body);
  });
}

function checkUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefusedError(`Won't follow a ${url.protocol} link`);
  if (url.username || url.password) throw new FetchRefusedError("Won't follow a link with a login in it");
  if (url.port && url.port !== "80" && url.port !== "443") throw new FetchRefusedError(`Won't connect to port ${url.port}`);
  if (!normalizeHost(url.hostname)) throw new FetchRefusedError(`${url.hostname} isn't a public website`);
}

/** GET (or POST) a public URL, following up to `maxRedirects` redirects, each one checked again. */
export async function safeFetch(input: string, options: FetchOptions = {}): Promise<FetchResult> {
  const opts: RequestOptions = {
    userAgent: options.userAgent ?? TOOL_USER_AGENT,
    maxBytes: options.maxBytes ?? 2_000_000,
    timeoutMs: options.timeoutMs ?? 8000,
    headOnly: options.headOnly ?? false,
    method: options.method,
    headers: options.headers,
    body: options.body,
  };
  const maxRedirects = options.headers || options.body !== undefined ? 0 : (options.maxRedirects ?? 5);
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const redirects: string[] = [];
  let url = new URL(input);
  for (;;) {
    checkUrl(url);
    const res = await requestOnce(url, opts, deadline);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location && redirects.length < maxRedirects) {
      redirects.push(url.toString());
      url = new URL(location, url);
      continue;
    }
    return { ...res, url: url.toString(), redirects, ms: Date.now() - started };
  }
}

/** A plain-English reason a fetch failed, for the result page. */
/** The visitor's site couldn't be read. Its message is written for the visitor and is shown to them. */
export class SiteUnreachableError extends Error {}

export function fetchErrorMessage(err: unknown): string {
  if (err instanceof FetchRefusedError) return err.message;
  const code = (err as { code?: string })?.code;
  if (code === "EPRIVATE") return "That address points at a private network, so we won't fetch it.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "We couldn't find that domain in DNS.";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "The site didn't answer within 8 seconds.";
  if (code === "ECONNREFUSED") return "The site refused the connection.";
  if (code === "ECONNRESET") return "The site closed the connection.";
  if (typeof code === "string" && /CERT|SSL|TLS/i.test(code)) return "The site's HTTPS certificate isn't valid.";
  return "We couldn't fetch the site.";
}
