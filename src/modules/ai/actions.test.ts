import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Refusal } from "@/lib/billing/errors";
import { OpError } from "@/lib/ops";
import { runNow } from "./actions";
import { startAiRunOp } from "./ops";

vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/app/actions/projects", () => ({ addCompetitor: vi.fn() }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => ({ id: "u1" }) }));
vi.mock("@/lib/billing/workspace", () => ({ gateRefusal: vi.fn(), loadBillingWorkspace: vi.fn(), projectActionRefusal: vi.fn(), promptGate: vi.fn() }));
vi.mock("@/lib/projects", () => ({ normalizeDomain: (d: string) => d, requireProject: async () => ({ project: { id: 1 }, scope: { workspaceId: 7, projectId: 1 } }) }));
vi.mock("./dfs", () => ({ fetchProjectKeywords: vi.fn() }));
vi.mock("./ops", () => ({ addPromptsOp: vi.fn(), platformsSchema: {}, projectTopics: vi.fn(), startAiRunOp: vi.fn() }));
vi.mock("./run", () => ({ loadBrands: vi.fn(), redetectProject: vi.fn() }));

describe("runNow", () => {
  beforeEach(() => {
    vi.mocked(startAiRunOp).mockReset();
  });

  it("says Upgrade now would help when a trial limit refused the run", async () => {
    const refusal: Refusal = { code: "ceiling", message: "Your trial's allowance is used up.", upgradable: true };
    vi.mocked(startAiRunOp).mockRejectedValueOnce(new OpError(`Not started. ${refusal.message}`, refusal));
    await expect(runNow(1)).resolves.toEqual({ ok: false, message: "Not started. Your trial's allowance is used up.", upgradable: true });
  });

  it("doesn't offer it on a refusal it wouldn't lift", async () => {
    const refusal: Refusal = { code: "credits", message: "All 100 research credits for this month are used.", upgradable: false };
    vi.mocked(startAiRunOp).mockRejectedValueOnce(new OpError(`Not started. ${refusal.message}`, refusal));
    expect((await runNow(1)).upgradable).toBe(false);
  });

  it("doesn't offer it when nothing was refused", async () => {
    vi.mocked(startAiRunOp).mockRejectedValueOnce(new OpError("No active prompts to run. Add prompts first."));
    const result = await runNow(1);
    expect(result).toMatchObject({ ok: false, message: "No active prompts to run. Add prompts first." });
    expect(result.upgradable).toBeUndefined();
  });

  it("confirms a queued run", async () => {
    vi.mocked(startAiRunOp).mockResolvedValueOnce({} as never);
    await expect(runNow(1)).resolves.toMatchObject({ ok: true });
  });
});
