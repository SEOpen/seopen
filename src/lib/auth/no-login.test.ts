import { describe, expect, it } from "vitest";
import { gatewayFromRouteTable, isLoopbackAddress, noLoginAllowed, noLoginRefusal } from "./no-login";

const ON = { SEOPEN_NO_LOGIN: "1" };

/** A browser on this machine, as Next hands the request on: Host as typed, and the socket's address in x-forwarded-for. */
function local(host = "127.0.0.1:4100", from = "127.0.0.1", extra: Record<string, string> = {}) {
  return new Headers({ host, "x-forwarded-for": from, ...extra });
}

describe("no-login mode", () => {
  it("is on for a browser on this machine, at either loopback name", () => {
    expect(noLoginAllowed(local(), ON, null)).toBe(true);
    expect(noLoginAllowed(local("localhost:4100", "::1"), ON, null)).toBe(true);
    expect(noLoginAllowed(local("[::1]:4100", "::ffff:127.0.0.1"), ON, null)).toBe(true);
  });

  it("is off unless SEOPEN_NO_LOGIN is exactly 1", () => {
    expect(noLoginRefusal(local(), {}, null)).toMatch(/SEOPEN_NO_LOGIN/);
    expect(noLoginAllowed(local(), { SEOPEN_NO_LOGIN: "true" }, null)).toBe(false);
  });

  it("is off on the hosted service and on a copy given a public address", () => {
    for (const env of [{ VERCEL: "1" }, { SEOPEN_DEPLOY_ENV: "production" }, { SEOPEN_APP_HOST: "app.example.com" }, { SEOPEN_SITE_HOST: "example.com" }, { BETTER_AUTH_URL: "https://seo.example.com" }, { BETTER_AUTH_URL: "not a url" }, { SEOPEN_TRUST_PROXY: "1" }]) {
      expect(noLoginAllowed(local(), { ...ON, ...env }, null)).toBe(false);
    }
    // A loopback base URL is still this machine.
    expect(noLoginAllowed(local(), { ...ON, BETTER_AUTH_URL: "http://127.0.0.1:4100" }, null)).toBe(true);
  });

  it("is off when the page was asked for by any other name, even one that points here", () => {
    for (const host of ["seo.example.com", "192.168.1.20:4100", "127.0.0.1.nip.io:4100", "attacker.test"]) {
      expect(noLoginRefusal(local(host), ON, null)).toMatch(/other than 127\.0\.0\.1/);
    }
    expect(noLoginAllowed(new Headers({ "x-forwarded-for": "127.0.0.1" }), ON, null)).toBe(false);
  });

  it("is off for a visitor from another machine or through a proxy", () => {
    expect(noLoginRefusal(local(undefined, "203.0.113.9"), ON, null)).toMatch(/another machine/);
    // A reverse proxy's address list, with the visitor first.
    expect(noLoginAllowed(local(undefined, "203.0.113.9, 127.0.0.1"), ON, null)).toBe(false);
    expect(noLoginAllowed(local(undefined, "127.0.0.1", { "x-real-ip": "203.0.113.9" }), ON, null)).toBe(false);
    expect(noLoginAllowed(local(undefined, "127.0.0.1", { forwarded: "for=203.0.113.9" }), ON, null)).toBe(false);
    expect(noLoginAllowed(local(undefined, "127.0.0.1", { "cloudfront-viewer-address": "203.0.113.9:443" }), ON, null)).toBe(false);
    expect(noLoginRefusal(new Headers({ host: "127.0.0.1:4100" }), ON, null)).toMatch(/unknown/);
  });

  it("counts the Docker gateway as this machine only inside a container", () => {
    expect(noLoginAllowed(local(undefined, "172.17.0.1"), ON, "172.17.0.1")).toBe(true);
    expect(noLoginAllowed(local(undefined, "172.17.0.1"), ON, null)).toBe(false);
    expect(noLoginAllowed(local(undefined, "172.17.0.5"), ON, "172.17.0.1")).toBe(false);
  });
});

describe("addresses", () => {
  it("knows loopback addresses", () => {
    for (const ip of ["127.0.0.1", "127.8.8.8", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(ip)).toBe(true);
    for (const ip of ["10.0.0.1", "0.0.0.0", "::", "::ffff:10.0.0.1", "128.0.0.1", ""]) expect(isLoopbackAddress(ip)).toBe(false);
  });

  it("reads the default gateway from the kernel's route table", () => {
    const table = "Iface\tDestination\tGateway\tFlags\nnet0\t00000000\t010011AC\t0003\nnet0\t000011AC\t00000000\t0001\n";
    expect(gatewayFromRouteTable(table)).toBe("172.17.0.1");
    expect(gatewayFromRouteTable("Iface\tDestination\tGateway\n")).toBeNull();
    // As a compose project's web container on Docker Desktop prints it: padded header and trailing spaces.
    const docker = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT   \neth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0   \neth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0   \n";
    expect(gatewayFromRouteTable(docker)).toBe("172.18.0.1");
  });
});
