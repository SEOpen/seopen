import { duplexPair } from "node:stream";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * safeFetch stops decompressing when it stops reading. A few kilobytes of brotli can hold gigabytes,
 * so a decompressor left running after the byte cap or the deadline costs seconds of CPU per fetch.
 * Node's own client and HTTP parser talk to an in-process server over a stream pair: only `request`
 * is wrapped, to swap the connection for the pair, so nothing leaves the process.
 */

const server = vi.hoisted(() => ({ respond: (_res: import("node:http").ServerResponse) => {} }));

vi.mock("node:http", async (original) => {
  const real = await original<typeof import("node:http")>();
  const http = real.default ?? real;
  const stub = (s: object) => Object.assign(s, { setTimeout: () => s, setKeepAlive: () => s, setNoDelay: () => s, ref: () => s, unref: () => s });
  const origin = http.createServer((_req, res) => server.respond(res));
  const request = (url: URL, opts: object, onResponse: (res: import("node:http").IncomingMessage) => void) =>
    http.request(
      url,
      {
        ...opts,
        lookup: undefined,
        createConnection: () => {
          const [client, remote] = duplexPair();
          stub(client);
          stub(remote);
          origin.emit("connection", remote);
          return client as never;
        },
      } as never,
      onResponse,
    );
  return { ...real, default: { ...http, request }, request };
});

const { safeFetch } = await import("./fetch");

/** Brotli of `mib` MiB of zero bytes: a few hundred bytes on the wire. */
async function zeros(mib: number): Promise<Buffer> {
  const enc = zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
  const out: Buffer[] = [];
  enc.on("data", (c: Buffer) => out.push(c));
  const done = new Promise((r) => enc.on("end", r));
  const block = Buffer.alloc(16 * 1024 * 1024);
  for (let i = 0; i < mib / 16; i++) if (!enc.write(block)) await new Promise((r) => enc.once("drain", r));
  enc.end();
  await done;
  return Buffer.concat(out);
}

/** Watches the decompressor safeFetch makes: how much it produced, and whether it was destroyed. */
function watch() {
  const real = zlib.createBrotliDecompress.bind(zlib);
  const seen = { bytes: 0, stream: null as zlib.BrotliDecompress | null };
  vi.spyOn(zlib, "createBrotliDecompress").mockImplementation((...args: Parameters<typeof real>) => {
    const s = real(...args);
    seen.stream = s;
    s.on("data", (c: Buffer) => (seen.bytes += c.length));
    return s;
  });
  return seen;
}

const settle = () => new Promise((r) => setTimeout(r, 300));

afterEach(() => vi.restoreAllMocks());

describe("safeFetch and a compressed body", () => {
  it("stops the decompressor at the byte cap", async () => {
    const body = await zeros(512);
    server.respond = (res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br", "content-length": String(body.length) });
      res.end(body);
    };
    const seen = watch();
    const maxBytes = 100_000;
    const got = await safeFetch("http://example.com/", { maxBytes, timeoutMs: 8000 });
    await settle();

    expect(got.truncated).toBe(true);
    expect(Buffer.byteLength(got.body)).toBe(maxBytes);
    expect(seen.stream?.destroyed).toBe(true);
    // Whatever was in flight when the cap was hit, and no more: nowhere near the 512 MiB inside.
    expect(seen.bytes).toBeLessThan(16 * 1024 * 1024);
  }, 60_000);

  it("stops the decompressor when the deadline passes", async () => {
    server.respond = (res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br", "content-length": "100000" });
      res.write(zlib.brotliCompressSync(Buffer.alloc(1000, 97)).subarray(0, 8));
    };
    const seen = watch();
    await expect(safeFetch("http://example.com/", { timeoutMs: 300 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await settle();

    expect(seen.stream).not.toBeNull();
    expect(seen.stream?.destroyed).toBe(true);
  }, 20_000);

  it("still reads a small compressed page whole", async () => {
    const page = "<title>Hi</title>".repeat(50);
    server.respond = (res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
      res.end(zlib.brotliCompressSync(Buffer.from(page)));
    };
    const got = await safeFetch("http://example.com/", { timeoutMs: 8000 });
    expect(got.truncated).toBe(false);
    expect(got.body).toBe(page);
  });
});
