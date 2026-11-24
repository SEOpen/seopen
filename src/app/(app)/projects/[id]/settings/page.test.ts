import { beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ search: vi.fn(), analytics: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); }, usePathname: () => "/", useRouter: () => ({ refresh() {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/projects", async (original) => ({
  ...(await original<typeof import("@/lib/projects")>()),
  getProject: async () => ({ id: 1, workspaceId: 7, name: "p", domain: "example.com", archived: false, locationCode: 2840, languageCode: "en" }),
  listCompetitors: async () => [],
}));
vi.mock("@/lib/workspace/current", async (original) => ({ ...(await original<typeof import("@/lib/workspace/current")>()), currentTimeZone: async () => "UTC" }));
vi.mock("@/modules/google/failure", async (original) => ({ ...(await original<typeof import("@/modules/google/failure")>()), searchConsoleFailures: reads.search, analyticsFailures: reads.analytics }));

const { default: Page } = await import("./page");

const open = () => Page({ params: Promise.resolve({ id: "1" }) } as Parameters<typeof Page>[0]);

beforeEach(() => {
  reads.search.mockReset();
  reads.analytics.mockReset();
});

describe("Project settings", () => {
  it("still opens, with Archive and Delete, when the failed checks can't be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    reads.search.mockRejectedValue(new Error("down"));
    reads.analytics.mockRejectedValue(new Error("down"));
    await expect(open()).resolves.toBeTruthy();
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
