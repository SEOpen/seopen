import { describe, expect, it, vi } from "vitest";
import { GoogleAccessError } from "./auth";
import { GoogleNotConnectedError } from "./types";

const syncGsc = vi.fn();
vi.mock("./sync", () => ({ syncGsc: (...a: unknown[]) => syncGsc(...a), syncGa4: vi.fn() }));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ activeProjects: vi.fn(), jobScope: async () => ({ ok: true, scope: { workspaceId: 1, projectId: 2 } }) }));

const { jobs } = await import("./jobs");
const gsc = jobs.find((j) => j.name === "google.gsc.sync")!;
const run = () => gsc.handler({ workspaceId: 1, projectId: 2 }, {} as never);

describe("google sync job", () => {
  it("doesn't retry a property the account can't reach", async () => {
    syncGsc.mockRejectedValueOnce(new GoogleAccessError("User does not have sufficient permission"));
    await expect(run()).resolves.toEqual({ skipped: "User does not have sufficient permission" });
  });

  it("doesn't retry a lost connection", async () => {
    syncGsc.mockRejectedValueOnce(new GoogleNotConnectedError("reauth_required"));
    await expect(run()).resolves.toHaveProperty("skipped");
  });

  it("still retries anything else", async () => {
    syncGsc.mockRejectedValueOnce(new Error("Request failed with status code 500"));
    await expect(run()).rejects.toThrow("status code 500");
  });
});
