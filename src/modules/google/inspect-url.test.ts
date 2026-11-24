import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAccessError } from "./auth";
import { GoogleQuotaError } from "./types";
import { inspectFailureMessage, urlInProperty } from "./inspect-url";

// The hosted service's words; failure-copy.test.ts checks a self-hosted copy's.
beforeEach(() => vi.stubEnv("SEOPEN_HAS_SITE", "1"));
afterEach(() => vi.unstubAllEnvs());

describe("urlInProperty", () => {
  it.each([
    ["https://x.com/", "sc-domain:x.com"],
    ["http://x.com/page", "sc-domain:x.com"],
    ["https://www.x.com/page", "sc-domain:x.com"],
    ["https://a.b.x.com/", "sc-domain:x.com"],
    ["https://X.COM/", "sc-domain:x.com"],
    ["https://www.x.com/", "https://www.x.com/"],
    ["https://www.x.com/blog/post", "https://www.x.com/"],
    ["https://www.x.com/blog/post", "https://www.x.com/blog/"],
    ["https://WWW.x.com/", "https://www.x.com/"],
  ])("%s is in %s", (url, property) => {
    expect(urlInProperty(url, property)).toBe(true);
  });

  it.each([
    ["https://notx.com/", "sc-domain:x.com"],
    ["https://x.com.evil.test/", "sc-domain:x.com"],
    ["https://y.com/", "sc-domain:x.com"],
    ["ftp://x.com/", "sc-domain:x.com"],
    ["http://www.x.com/", "https://www.x.com/"],
    ["https://x.com/", "https://www.x.com/"],
    ["https://blog.x.com/", "https://www.x.com/"],
    ["https://www.x.com.evil.test/", "https://www.x.com/"],
    ["https://www.x.com/", "https://www.x.com/blog/"],
    ["https://www.x.com/blogs/", "https://www.x.com/blog/"],
    ["not a url", "sc-domain:x.com"],
  ])("%s isn't in %s", (url, property) => {
    expect(urlInProperty(url, property)).toBe(false);
  });
});

describe("inspectFailureMessage", () => {
  const http = (status: number) => Object.assign(new Error("Google's own text"), { response: { status } });
  const RETRY = "Google didn't answer that inspection. Try again in a minute.";

  it.each([500, 503])("asks to try again on HTTP %i", (status) => {
    expect(inspectFailureMessage(http(status))).toBe(RETRY);
  });

  it("asks to try again on a network failure, direct or wrapped", () => {
    expect(inspectFailureMessage(Object.assign(new Error("request failed"), { code: "ECONNRESET" }))).toBe(RETRY);
    expect(inspectFailureMessage(new TypeError("fetch failed"))).toBe(RETRY);
    expect(inspectFailureMessage(new Error("x", { cause: Object.assign(new Error("y"), { code: "UND_ERR_SOCKET" }) }))).toBe(RETRY);
  });

  it.each([400, 404])("doesn't ask to try again on HTTP %i", (status) => {
    const message = inspectFailureMessage(http(status));
    expect(message).toBe("Google wouldn't inspect that URL. Check that the address is right.");
    expect(message).not.toMatch(/again|Google's own/);
  });

  it("doesn't blame Google or ask to try again when the failure is ours", () => {
    expect(inspectFailureMessage(Object.assign(new Error('relation "x" does not exist'), { code: "42P01" }))).toBe("That inspection didn't finish. It's a problem on our side, and there's nothing for you to fix.");
  });

  it("keeps the words of a failure SEOpen can name", () => {
    expect(inspectFailureMessage(new GoogleAccessError("no"))).toBe("This Google account can't reach that property. Check its access in Google, or reconnect Google.");
    expect(inspectFailureMessage(new GoogleQuotaError("Quota exceeded"))).toBe("Try again in a few minutes.");
  });
});
