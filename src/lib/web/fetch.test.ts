import { describe, expect, it } from "vitest";
import { inputPath, isPublicAddress, normalizeHost, siteDomain } from "./fetch";

describe("isPublicAddress", () => {
  it("rejects private, loopback, link-local and mapped private addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fec0::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:a00:1", "::ffff:7f00:1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });
  it("rejects private IPv4 inside IPv4-compatible and translated IPv6, in any spelling", () => {
    for (const a of [
      "::127.0.0.1", "::7f00:1", "::10.0.0.1", "::a00:1", "::169.254.169.254", "::192.168.1.1", "::0.0.0.0",
      "::ffff:0:7f00:1", "::ffff:0:127.0.0.1", "::ffff:0:a00:1", "::ffff:0:169.254.169.254",
      "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:0:127.0.0.1", "0:0:0:0:ffff:0:7f00:1", "::FFFF:7F00:1", "::",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });
  it("accepts public addresses", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::6810:85e5")).toBe(true);
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
  });
  it("rejects things that aren't addresses", () => {
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("normalizeHost", () => {
  it("reduces a URL to its hostname", () => {
    expect(normalizeHost(" https://WWW.Example.com/a?b ")).toBe("www.example.com");
    expect(normalizeHost("blog.example.co.uk")).toBe("blog.example.co.uk");
  });
  it("rejects IPs, local names, odd ports, credentials and other schemes", () => {
    for (const s of ["127.0.0.1", "http://[::1]/", "localhost", "intranet", "example.com:8080", "https://u:p@example.com", "ftp://example.com", "file:///etc/passwd", "metadata.internal"]) {
      expect(normalizeHost(s), s).toBeNull();
    }
  });
});

describe("siteDomain and inputPath", () => {
  it("finds the registrable domain", () => {
    expect(siteDomain("shop.example.co.uk")).toBe("example.co.uk");
  });
  it("keeps the path and query the visitor typed", () => {
    expect(inputPath("example.com/pricing?x=1")).toBe("/pricing?x=1");
    expect(inputPath("example.com")).toBe("/");
  });
});
