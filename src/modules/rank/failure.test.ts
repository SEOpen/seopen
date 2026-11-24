import { describe, expect, it, vi } from "vitest";
import { creditsRefusal, PLATFORM_REFUSAL } from "@/lib/billing/spend";
import { POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { rankFailure } from "./failure";
import { rules } from "@/plan-policy/rules";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-11-07T12:00:00Z");
const at = new Date("2026-11-07T11:30:00Z");

describe("rankFailure", () => {
  it("says a whole check's failure in the customer's words, never the vendor's", () => {
    const f = rankFailure({ status: "failed", error: null, createdAt: at, finishedAt: at }, "UTC", NOW);
    expect(f).toMatchObject({ kind: "failed", noun: "check", day: "Nov 7", reason: "None of this check's searches came back.", retry: true });
    expect(rankFailure({ status: "failed", error: "No answer from DataForSEO", createdAt: at, finishedAt: at }, "UTC", NOW)?.reason).not.toMatch(/DataForSEO/);
  });

  it.skipIf(!rules.hasPlans)("sends a refusal to Billing, since Check now can't get past it", () => {
    const f = rankFailure({ status: "failed", error: creditsRefusal({ plan: "starter" }, 10).message, createdAt: at, finishedAt: at }, "UTC", NOW);
    expect(f).toMatchObject({ retry: false, next: { label: "Open Billing", href: "/billing" } });
  });

  it("doesn't send what Billing can't lift to Billing", () => {
    const f = rankFailure({ status: "failed", error: PLATFORM_REFUSAL.message, createdAt: at, finishedAt: at }, "UTC", NOW);
    expect(f).toMatchObject({ retry: false, next: { label: "View", href: "/rank" } });
  });

  it("doesn't offer a retry that can't fix a rejected check or one down on the service's side", () => {
    const rejected = rankFailure({ status: "failed", error: "40501 Invalid Field", createdAt: at, finishedAt: at }, "UTC", NOW);
    expect(rejected).toMatchObject({ retry: false, reason: "The search service rejected this check, so running it again won't help. Check the project's keywords and location." });
    const down = rankFailure({ status: "failed", error: "40200 Payment Required", createdAt: at, finishedAt: at }, "UTC", NOW);
    expect(down?.retry).toBe(false);
    expect(down?.reason).not.toMatch(/40200|Payment/);
  });

  it("says a row the next check closed for never starting didn't start, too", () => {
    const f = rankFailure({ status: "failed", error: POSTING_NEVER_FINISHED, createdAt: at, finishedAt: at }, "UTC", NOW);
    expect(f).toMatchObject({ stuck: true, reason: "This check didn't start.", retry: true });
  });

  it("is nothing while a check is running or after one succeeded", () => {
    expect(rankFailure({ status: "pending", error: null, createdAt: at }, "UTC", NOW)).toBeNull();
    expect(rankFailure({ status: "posting", error: null, createdAt: at }, "UTC", NOW)).toBeNull();
    expect(rankFailure({ status: "done", error: null, createdAt: at }, "UTC", NOW)).toBeNull();
    expect(rankFailure(null, "UTC", NOW)).toBeNull();
  });

  it("calls a check stuck posting past the existing hour a failure", () => {
    const f = rankFailure({ status: "posting", error: null, createdAt: new Date(NOW.getTime() - 61 * 60_000) }, "UTC", NOW);
    expect(f).toMatchObject({ reason: "This check didn't start.", retry: true });
  });
});
