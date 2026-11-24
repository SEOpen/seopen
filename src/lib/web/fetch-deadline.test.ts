import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * safeFetch's total deadline. The socket's own timeout only fires on silence, so a site
 * that sends a byte every so often held the request open for good. node:http is faked: the fake
 * never resolves DNS, so the address guard isn't involved, and nothing leaves the machine.
 */

const drips: NodeJS.Timeout[] = [];

/** A response that sends `chunk` every 50 ms and never ends, or `body` at once. */
const server = vi.hoisted(() => ({ mode: "drip" as "drip" | "fast" }));

vi.mock("node:http", () => {
  const request = (_url: URL, _opts: object, onResponse: (res: PassThrough) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (err?: Error) => void };
    const res = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "text/html" } });
    req.destroy = (err?: Error) => {
      res.destroy();
      if (err) req.emit("error", err);
    };
    req.end = () =>
      setImmediate(() => {
        onResponse(res);
        if (server.mode === "fast") return void res.end("<title>Hi</title>");
        const t = setInterval(() => res.write("a"), 50);
        drips.push(t);
        res.on("close", () => clearInterval(t));
      });
    return req;
  };
  return { default: { request }, request };
});

const { safeFetch } = await import("./fetch");

afterEach(() => {
  for (const t of drips.splice(0)) clearInterval(t);
});

describe("safeFetch", () => {
  it("gives up on a site that keeps sending a byte at a time, at the deadline", async () => {
    server.mode = "drip";
    const started = Date.now();
    await expect(safeFetch("http://example.com/", { timeoutMs: 300 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("returns a page that answers in time", async () => {
    server.mode = "fast";
    const res = await safeFetch("http://example.com/", { timeoutMs: 300 });
    expect(res).toMatchObject({ status: 200, body: "<title>Hi</title>", truncated: false });
  });
});
