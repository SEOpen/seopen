import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The client tells the balance alert about a refused payment: an HTTP 402, or DataForSEO's own
 * 40200 or 40210 in a 200 response. It tells the daily limit alert about a 40203, for the whole call
 * or one of its tasks. `fetch` is stubbed, so nothing reaches DataForSEO, and the call
 * is free and has no workspace, so nothing touches the database.
 */

const noted = vi.hoisted(() => [] as string[]);
const limited = vi.hoisted(() => [] as string[]);
vi.mock("server-only", () => ({}));
vi.mock("./balance", async (orig) => ({
  ...(await orig<typeof import("./balance")>()),
  notePaymentRequired: async (endpoint: string) => {
    noted.push(endpoint);
  },
  noteDailyLimit: async (endpoint: string) => {
    limited.push(endpoint);
  },
}));

const { DataForSEOError, dfsGet } = await import("./client");

function answer(status: number, body: object = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const call = () => dfsGet("serp/google/organic/tasks_ready", { module: "rank", free: true });

describe("a refused payment", () => {
  beforeAll(() => {
    vi.stubEnv("SEOPEN_SECRET_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("DATAFORSEO_LOGIN", "test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "test");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    noted.length = 0;
    limited.length = 0;
  });
  afterAll(() => vi.unstubAllEnvs());

  it("tells the balance alert about an HTTP 402", async () => {
    answer(402, { status_code: 40200, status_message: "Payment Required." });
    await expect(call()).rejects.toThrow(DataForSEOError);
    expect(noted).toEqual(["serp/google/organic/tasks_ready"]);
  });

  it("tells it about 40200 and 40210 in a 200 response", async () => {
    for (const code of [40200, 40210]) {
      answer(200, { status_code: code, status_message: "Insufficient funds.", tasks: [] });
      await expect(call()).rejects.toThrow(DataForSEOError);
    }
    expect(noted).toHaveLength(2);
  });

  it("says nothing about other failures", async () => {
    answer(500);
    await expect(dfsGet("x/live", { module: "rank", free: true, retries: 0 })).rejects.toThrow(DataForSEOError);
    answer(200, { status_code: 40100, status_message: "Not authorized.", tasks: [] });
    await expect(call()).rejects.toThrow(DataForSEOError);
    expect(noted).toEqual([]);
  });

  it("tells the daily limit alert about a 40203, for the call or for one task", async () => {
    answer(200, { status_code: 40203, status_message: "The cost limit has been exceeded.", tasks: [] });
    await expect(call()).rejects.toThrow(DataForSEOError);
    answer(200, { status_code: 20000, status_message: "Ok.", tasks_error: 1, tasks: [{ status_code: 40203, status_message: "The cost limit has been exceeded." }] });
    await call();
    expect(limited).toEqual(["serp/google/organic/tasks_ready", "serp/google/organic/tasks_ready"]);
    expect(noted).toEqual([]);
  });
});
