import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/ui/data-table";
import { POSTING_NEVER_FINISHED } from "@/lib/check-failure";

const runs = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ usePathname: () => "/rank/settings", useRouter: () => ({ refresh() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/projects", async (original) => ({ ...(await original<typeof import("@/lib/projects")>()), getCurrentProject: async () => ({ id: 1, workspaceId: 7 }) }));
vi.mock("@/lib/workspace/current", async (original) => ({ ...(await original<typeof import("@/lib/workspace/current")>()), currentTimeZone: async () => "UTC", currentWorkspace: async () => ({ id: 7, plan: "starter" }) }));
vi.mock("@/modules/rank/queries", async (original) => ({
  ...(await original<typeof import("@/modules/rank/queries")>()),
  loadTracker: async () => ({ settings: { dailyDepth: 10, sweepDepth: 100, sweepWeekday: 0, enabled: true }, keywords: [], places: [], dates: [], place: { current: true } }),
  listRuns: async () => runs.current,
}));

const { default: Page } = await import("./page");

function tables(node: ReactNode, out: ReactElement<{ rows: { status: string }[] }>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => tables(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode; rows?: { status: string }[] }>;
    if (el.type === DataTable) out.push(el as ReactElement<{ rows: { status: string }[] }>);
    tables(el.props.children, out);
  }
  return out;
}

const run = (status: string, createdAt: Date, error: string | null = null) => ({ id: 1, kind: "manual", depth: 10, status, error, createdAt, finishedAt: null, tasksDone: 0, tasksTotal: 0 });
const statuses = async () => tables(await Page()).find((t) => t.props.rows?.some((r) => "status" in r))!.props.rows.map((r) => r.status);

describe("the runs table", () => {
  it("doesn't show posting past the hour, under a callout that says otherwise", async () => {
    runs.current = [run("posting", new Date(Date.now() - 2 * 3_600_000))];
    expect(await statuses()).toEqual(["didn't start"]);
  });

  it("nor failed, once a later check closed that row", async () => {
    runs.current = [run("failed", new Date(Date.now() - 48 * 3_600_000), POSTING_NEVER_FINISHED)];
    expect(await statuses()).toEqual(["didn't start"]);
  });

  it("keeps the others as they are", async () => {
    runs.current = [run("posting", new Date()), run("failed", new Date(), "Timed out"), run("done", new Date())];
    expect(await statuses()).toEqual(["posting", "failed", "done"]);
  });
});
