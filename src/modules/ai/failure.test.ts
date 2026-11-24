import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { creditsRefusal, PLATFORM_REFUSAL } from "@/lib/billing/spend";
import { plainAiFailure } from "@/lib/dataforseo/failure-copy";
import { aiFailure, aioFailure, aiFix, aiRunAgain, aiRunLabel, mentionsCheckFailure } from "./failure";
import { rules } from "@/plan-policy/rules";

// The hosted service's words; failure-copy.test.ts checks a self-hosted copy's.
beforeEach(() => vi.stubEnv("SEOPEN_HAS_SITE", "1"));
afterEach(() => vi.unstubAllEnvs());

vi.mock("server-only", () => ({}));

const at = new Date("2026-11-07T10:00:00Z");
const run = (error: string | null, status = "failed") => ({ status, error, createdAt: at });

describe("aiFailure", () => {
  it("says a run whose job was lost didn't start, quietly", () => {
    expect(aiFailure(run("Posting never finished"), "UTC")).toMatchObject({ reason: "This run didn't start.", stuck: true, retry: true });
  });

  it.skipIf(!rules.hasPlans)("offers Run now again only when that could work", () => {
    expect(aiFailure(run("Timed out"), "UTC")).toMatchObject({ noun: "run", day: "Nov 7", retry: true });
    expect(aiFailure(run(creditsRefusal({ plan: "starter" }, 10).message), "UTC")).toMatchObject({ retry: false, next: { href: "/billing" } });
    expect(aiFailure(run(PLATFORM_REFUSAL.message), "UTC")).toMatchObject({ retry: false, next: { label: "View", href: "/ai" } });
    expect(aiFailure(run("40501 Invalid Field"), "UTC")).toMatchObject({ retry: false, next: { href: "/ai/prompts" } });
    expect(aiFix("Timed out")).toBeNull();
  });

  it("never says to run it again twice, or when that can't help", () => {
    expect(plainAiFailure("Timed out")).toMatch(/again/i);
    expect(aiRunAgain("Timed out")).toBeNull();
    expect(aiRunAgain(PLATFORM_REFUSAL.message)).toBeNull();
    expect(aiRunAgain("40501 Invalid Field")).toBeNull();
  });

  it("doesn't call a failed run Not run yet or the last run", () => {
    const failed = aiFailure(run("Timed out"), "UTC");
    expect(aiRunLabel(null, failed)).toBe("Last run failed");
    expect(aiRunLabel("Nov 5", failed)).toBe("Answers from Nov 5");
    expect(aiRunLabel("Nov 5", null)).toBe("Last run Nov 5");
    expect(aiRunLabel(null, null)).toBe("Not run yet");
  });

  it("leaves a queued or running run alone, however old: there's no rule that says it's stuck", () => {
    expect(aiFailure(run(null, "queued"), "UTC")).toBeNull();
    expect(aiFailure(run(null, "running"), "UTC")).toBeNull();
    expect(aiFailure(run(null, "done"), "UTC")).toBeNull();
  });
});

describe("the weekly checks beside a run", () => {
  const OUR_SIDE = "isn't available right now. It's a problem on our side, and there's nothing for you to fix.";

  it("says an AI Overview check that couldn't run, on the day it ran", () => {
    const f = aioFailure({ at: new Date("2026-11-09T12:00:00Z"), stored: "DataForSEO HTTP 402 on serp/google/organic/task_post" }, "America/New_York");
    expect(f).toMatchObject({ kind: "failed", noun: "check", day: "Nov 9", retry: false, next: { label: "View", href: "/ai" } });
    expect(f.reason).toBe(`Google data ${OUR_SIDE}`);
  });

  it("says a Mentions refresh that couldn't run, from the call the ledger kept", () => {
    const f = mentionsCheckFailure({ at: new Date("2026-11-09T12:05:00Z"), statusCode: 402, endpoint: "ai_optimization/llm_mentions/target_metrics/live" }, "America/New_York");
    expect(f).toMatchObject({ kind: "failed", noun: "check", day: "Nov 9", retry: false });
    expect(f.reason).toBe(`AI answer data ${OUR_SIDE}`);
  });
});
