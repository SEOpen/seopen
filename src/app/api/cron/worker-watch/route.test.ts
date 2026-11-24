import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The check itself has its own tests (src/lib/jobs/worker-watch.db.test.ts); this is the door to it.
const checkWorker = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jobs/worker-watch", () => ({ checkWorker }));

const { GET } = await import("./route");

const call = (authorization?: string) => GET(new Request("https://app.getseopen.com/api/cron/worker-watch", { headers: authorization ? { authorization } : {} }));

describe("the worker watch route", () => {
  beforeEach(() => {
    checkWorker.mockReset();
    checkWorker.mockResolvedValue({ state: "up", emailed: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses everyone while CRON_SECRET isn't set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(503);
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong secret", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(checkWorker).not.toHaveBeenCalled();
  });

  it("runs the check for Vercel's cron and answers what it found", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "up", emailed: null });
  });

  it("answers 500 when a send failed, so the cron run shows as failed", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    checkWorker.mockRejectedValue(new Error("Resend rejected the message"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("Bearer s3cret");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Resend rejected the message" });
  });
});
