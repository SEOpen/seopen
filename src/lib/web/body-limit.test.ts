import { describe, expect, it } from "vitest";
import { declaresTooLargeBody, PROXY_BODY_LIMIT_BYTES } from "./body-limit";

describe("declaresTooLargeBody", () => {
  it("is true only for a declared length over the limit", () => {
    const h = (length?: string) => new Headers(length === undefined ? {} : { "content-length": length });
    expect(declaresTooLargeBody(h(String(PROXY_BODY_LIMIT_BYTES + 1)))).toBe(true);
    expect(declaresTooLargeBody(h(String(PROXY_BODY_LIMIT_BYTES)))).toBe(false);
    expect(declaresTooLargeBody(h("0"))).toBe(false);
    expect(declaresTooLargeBody(h())).toBe(false);
    expect(declaresTooLargeBody(h("not a number"))).toBe(false);
  });

  it("is the limit next.config.ts gives the proxy's buffer", async () => {
    const { default: nextConfig } = await import("../../../next.config");
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe(PROXY_BODY_LIMIT_BYTES);
  });
});
