import { getIP } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_IP_HEADER, clientAddress, clientIp, withClientIpHeader } from "./client-ip";

const h = (o: Record<string, string>) => new Headers(o);

afterEach(() => vi.unstubAllEnvs());

describe("clientAddress", () => {
  it("is null when the headers can't be trusted", () => {
    expect(clientAddress(h({ "x-real-ip": "203.0.113.9" }), false)).toBeNull();
  });

  it("reads CloudFront's viewer address without its port, and ignores headers a visitor can write", () => {
    vi.stubEnv("SEOPEN_TRUST_PROXY", "cloudfront");
    expect(clientAddress(h({ "cloudfront-viewer-address": "198.51.100.10:46532", "x-real-ip": "203.0.113.9" }), true)).toBe("198.51.100.10");
    expect(clientAddress(h({ "cloudfront-viewer-address": "2001:db8::1:46532" }), true)).toBe("2001:db8::1");
    expect(clientAddress(h({ "x-real-ip": "203.0.113.9" }), true)).toBeNull();
  });

  it("reads only the header the proxy is named as writing", () => {
    // Caddy appends X-Forwarded-For and passes a visitor's X-Real-IP on untouched.
    vi.stubEnv("SEOPEN_TRUST_PROXY", "x-forwarded-for");
    expect(clientAddress(h({ "x-forwarded-for": "192.0.2.50, 198.51.100.10", "x-real-ip": "203.0.113.9" }))).toBe("198.51.100.10");
    expect(clientAddress(h({ "x-real-ip": "203.0.113.9" }))).toBeNull();
    // nginx setting only X-Real-IP passes a visitor's X-Forwarded-For on untouched.
    vi.stubEnv("SEOPEN_TRUST_PROXY", "X-Real-IP");
    expect(clientAddress(h({ "x-real-ip": "198.51.100.10", "x-forwarded-for": "203.0.113.9" }))).toBe("198.51.100.10");
    expect(clientAddress(h({ "x-forwarded-for": "203.0.113.9" }))).toBeNull();
  });

  it("keeps the older `1` reading X-Real-IP, then the last X-Forwarded-For entry", () => {
    vi.stubEnv("SEOPEN_TRUST_PROXY", "1");
    expect(clientAddress(h({ "x-real-ip": "198.51.100.10", "x-forwarded-for": "203.0.113.9" }))).toBe("198.51.100.10");
    expect(clientAddress(h({ "x-forwarded-for": "192.0.2.50, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("trusts nothing when unset or set to something it doesn't know", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SEOPEN_TRUST_PROXY", "");
    expect(clientAddress(h({ "x-real-ip": "203.0.113.9" }))).toBeNull();
    vi.stubEnv("SEOPEN_TRUST_PROXY", "yes");
    expect(clientAddress(h({ "x-real-ip": "203.0.113.9" }))).toBeNull();
  });

  it("is null for something that isn't an address", () => {
    expect(clientAddress(h({ "x-real-ip": "not-an-ip" }), true)).toBeNull();
  });
});

describe("clientIp", () => {
  it("still keys an untrusted or missing address as local, and IPv6 by its /56", () => {
    expect(clientIp(h({}), true)).toBe("local");
    expect(clientIp(h({ "x-real-ip": "203.0.113.9" }), false)).toBe("local");
    expect(clientIp(h({ "x-real-ip": "2001:db8:1:2a3:3:4:5:6" }), true)).toBe("2001:db8:1:200::/56");
  });
});

describe("withClientIpHeader", () => {
  it("sets the header from CloudFront's address and drops one the visitor sent", () => {
    vi.stubEnv("SEOPEN_TRUST_PROXY", "cloudfront");
    const out = withClientIpHeader(h({ "cloudfront-viewer-address": "198.51.100.10:46532", [CLIENT_IP_HEADER]: "192.0.2.1" }), true);
    expect(out.get(CLIENT_IP_HEADER)).toBe("198.51.100.10");
  });

  it("removes a forged header when there's no trusted address", () => {
    expect(withClientIpHeader(h({ [CLIENT_IP_HEADER]: "192.0.2.1" }), false).has(CLIENT_IP_HEADER)).toBe(false);
  });

  it("leaves the source headers alone", () => {
    const source = h({ [CLIENT_IP_HEADER]: "192.0.2.1" });
    withClientIpHeader(source, false);
    expect(source.get(CLIENT_IP_HEADER)).toBe("192.0.2.1");
  });

  it("gives Better Auth an address it accepts, so each visitor gets their own rate-limit bucket", () => {
    vi.stubEnv("SEOPEN_TRUST_PROXY", "cloudfront");
    const options = { advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } } };
    const ipFor = (viewer: string) => getIP(withClientIpHeader(h({ "cloudfront-viewer-address": viewer }), true), options as never);
    expect(ipFor("198.51.100.10:46532")).toBe("198.51.100.10");
    expect(ipFor("203.0.113.7:1")).toBe("203.0.113.7");
  });
});
