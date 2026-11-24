import { describe, expect, it } from "vitest";
import { classifyGoogleError, GoogleAccessError, GoogleServerError, missingScopes, shortGoogleMessage } from "./auth";
import { GoogleNotConnectedError, GoogleQuotaError, SCOPE_ANALYTICS, SCOPE_WEBMASTERS, SCOPE_WEBMASTERS_FULL, SCOPES } from "./types";

describe("classifyGoogleError", () => {
  const googleError = (status: number, message: string, data?: unknown) => Object.assign(new Error(message), { response: { status, data } });

  it("turns a 403 into an access error and keeps Google's text for the logs", async () => {
    const lost = googleError(403, "User does not have sufficient permission for site 'sc-domain:a.com'.");
    const thrown = classifyGoogleError(lost);
    await expect(thrown).rejects.toBeInstanceOf(GoogleAccessError);
    await expect(thrown).rejects.toThrow("sufficient permission");
  });

  it("reads the status from a bare error too", async () => {
    await expect(classifyGoogleError(Object.assign(new Error("Forbidden"), { status: 403 }))).rejects.toBeInstanceOf(GoogleAccessError);
  });

  it("keeps a 403 that is really a quota as a quota error", async () => {
    await expect(classifyGoogleError(googleError(403, "Forbidden", { error: { errors: [{ reason: "rateLimitExceeded" }] } }))).rejects.toBeInstanceOf(GoogleQuotaError);
  });

  it("keeps a revoked token as a reconnect", async () => {
    await expect(classifyGoogleError(googleError(400, "invalid_grant"))).rejects.toBeInstanceOf(GoogleNotConnectedError);
  });

  it("turns a 5xx into a server error and keeps a short API message", async () => {
    const thrown = classifyGoogleError(googleError(500, "Backend Error"));
    await expect(thrown).rejects.toBeInstanceOf(GoogleServerError);
    await expect(thrown).rejects.toThrow("Backend Error");
  });

  it("replaces Google's HTML error page with the status and its reason", async () => {
    const page = `<!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n  <title>Error 502 (Server Error)!!1</title>\n  <style>${"*{margin:0}".repeat(120)}</style>\n  <p><b>502.</b> <ins>That's an error.</ins>`;
    const thrown = classifyGoogleError(googleError(502, page));
    await expect(thrown).rejects.toBeInstanceOf(GoogleServerError);
    await expect(thrown).rejects.toThrow(/^Google returned HTTP 502 \(Server Error\)$/);
  });

  it("shortens an HTML page that comes without a 5xx", async () => {
    const thrown = classifyGoogleError(googleError(404, "<html><title>Error 404 (Not Found)!!1</title></html>"));
    await expect(thrown).rejects.toThrow(/^Google returned HTTP 404 \(Not Found\)$/);
  });

  it("does not read a quota word inside an error page as a quota error", async () => {
    const thrown = classifyGoogleError(googleError(503, "<html><title>Error 503 (Service Unavailable)!!1</title><p>quota</p></html>"));
    await expect(thrown).rejects.toBeInstanceOf(GoogleServerError);
  });

  it("caps a long plain message", () => {
    expect(shortGoogleMessage(new Error("x".repeat(1000)))).toHaveLength(301);
  });

  it("rethrows anything else as it is", async () => {
    const bad = googleError(400, "Invalid dimension");
    await expect(classifyGoogleError(bad)).rejects.toBe(bad);
  });
});

describe("scopes", () => {
  it("asks Google for read-only Search Console access", () => {
    expect(SCOPES).toContain("https://www.googleapis.com/auth/webmasters.readonly");
    expect(SCOPES).not.toContain(SCOPE_WEBMASTERS_FULL);
  });

  it("accepts a connection that has both read-only scopes", () => {
    expect(missingScopes({ scopes: ["openid", "email", SCOPE_WEBMASTERS, SCOPE_ANALYTICS] })).toEqual([]);
  });

  it("accepts an older connection holding the full Search Console scope", () => {
    expect(missingScopes({ scopes: ["openid", "email", SCOPE_WEBMASTERS_FULL, SCOPE_ANALYTICS] })).toEqual([]);
  });

  it("names what's missing", () => {
    expect(missingScopes({ scopes: ["openid", "email", SCOPE_ANALYTICS] })).toEqual([SCOPE_WEBMASTERS]);
  });
});
