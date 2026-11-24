import { beforeEach, describe, expect, it, vi } from "vitest";

/** `enqueue` carries an AI agent's `source` into the job's payload, so the worker can restore it. */

const { send, start, stop, constructed } = vi.hoisted(() => ({
  send: vi.fn(async () => "job-id"),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  constructed: [] as Record<string, unknown>[],
}));
vi.mock("pg-boss", () => ({
  PgBoss: class {
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
    on() {}
    start = start;
    stop = stop;
    send = send;
  },
}));

const { enqueue } = await import("./boss");
const { sourceOf, withBillingContext } = await import("@/lib/billing/context");

beforeEach(() => {
  globalThis.__seopenBoss = undefined;
  constructed.length = 0;
  send.mockClear();
  start.mockReset();
  stop.mockReset();
  start.mockImplementation(async () => {});
  stop.mockImplementation(async () => {});
});

describe("enqueue", () => {
  it("adds source only for work an agent started", async () => {
    await enqueue("rank.run", { runId: 1 });
    await withBillingContext({ source: "mcp" }, () => enqueue("rank.run", { runId: 2 }));
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ runId: 1 }, { runId: 2, source: "mcp" }]);
  });

  it("restores the source from a payload", () => {
    expect(sourceOf({ runId: 2, source: "mcp" })).toBe("mcp");
    expect(sourceOf({ runId: 1 })).toBeUndefined();
    expect(sourceOf({ source: "evil" })).toBeUndefined();
    expect(sourceOf(null)).toBeUndefined();
  });
});

describe("the sender", () => {
  it("starts once for many sends", async () => {
    await enqueue("rank.run", { runId: 1 });
    await enqueue("rank.run", { runId: 2 });
    expect(constructed).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("runs no background work that reconnects from a frozen function", async () => {
    await enqueue("rank.run", { runId: 1 });
    expect(constructed[0]).toMatchObject({
      supervise: false,
      schedule: false,
      migrate: false,
      registerInstance: false,
      queueCacheIntervalSeconds: 3600,
    });
  });

  it("tries again on the next send after a failed start, and cleans up the failed one", async () => {
    start.mockRejectedValueOnce(new Error("Connection terminated due to connection timeout"));
    await expect(enqueue("rank.run", { runId: 1 })).rejects.toThrow("connection timeout");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    await expect(enqueue("rank.run", { runId: 2 })).resolves.toBe("job-id");
    expect(constructed).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reports the start failure even when cleaning up also fails", async () => {
    start.mockRejectedValueOnce(new Error("start failed"));
    stop.mockRejectedValueOnce(new Error("stop failed"));
    await expect(enqueue("rank.run", { runId: 1 })).rejects.toThrow("start failed");
  });
});
