import { beforeEach, describe, expect, it, vi } from "vitest";

/** The AI assistants loader with every source's client faked. Every number here is made up. */

const rows = vi.hoisted(() => ({ ga4: vi.fn(), posthog: vi.fn(), plausible: vi.fn(), umami: vi.fn() }));
vi.mock("./apis", () => ({ googleApis: async () => ({ ga4: { sourceSessions: rows.ga4 } }) }));
vi.mock("@/modules/posthog/api", () => ({ posthogApis: () => ({ sourceSessions: rows.posthog }) }));
vi.mock("@/modules/plausible/api", () => ({ plausibleApis: () => ({ sourceSessions: rows.plausible }) }));
vi.mock("@/modules/umami/api", () => ({ umamiApis: () => ({ sourceSessions: rows.umami }) }));

const { aiReferrals, analyticsSourceOf, referralProblem } = await import("./ai-referrals");
const { aiSentence } = await import("./ui/ai-assistants");
const { GoogleNotConnectedError, GoogleQuotaError } = await import("./types");
const { PlausibleAccessError } = await import("@/modules/plausible/types");
const { UmamiUnreachableError } = await import("@/modules/umami/types");

const none = { workspaceId: 7, ga4Property: null, posthogProject: null, plausibleSite: null, umamiSite: null };
const period = { start: "2026-10-01", end: "2026-10-28" };

beforeEach(() => {
  for (const f of Object.values(rows)) f.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("analyticsSourceOf", () => {
  it("reads the source in the Analytics page's order", () => {
    expect(analyticsSourceOf(none)).toBeNull();
    expect(analyticsSourceOf({ ...none, ga4Property: "properties/1" })).toEqual({ key: "ga4", id: "properties/1" });
    expect(analyticsSourceOf({ ...none, ga4Property: "properties/1", posthogProject: "9" })).toEqual({ key: "posthog", id: "9" });
    expect(analyticsSourceOf({ ...none, umamiSite: "u-1", plausibleSite: "made-up.example" })).toEqual({ key: "umami", id: "u-1" });
  });
});

describe("aiReferrals", () => {
  it("asks the project's own source for the period, and groups its rows", async () => {
    rows.posthog.mockResolvedValue([
      { sources: [null, "chatgpt.com"], sessions: 6, engagedSessions: 3 },
      { sources: ["www.google.com", null], sessions: 80, engagedSessions: 40 },
    ]);
    const r = await aiReferrals({ ...none, posthogProject: "42" }, period);
    expect(rows.posthog).toHaveBeenCalledWith(42, "2026-10-01", "2026-10-28");
    expect(r).toEqual({ state: "ok", source: "posthog", period, sessions: 6, engagedSessions: 3, assistants: [{ id: "chatgpt", name: "ChatGPT", sessions: 6, engagedSessions: 3, seenAs: ["chatgpt.com"] }] });
  });

  it("reaches each source with its own id", async () => {
    for (const f of Object.values(rows)) f.mockResolvedValue([]);
    await aiReferrals({ ...none, ga4Property: "properties/1" }, period);
    await aiReferrals({ ...none, plausibleSite: "made-up.example" }, period);
    await aiReferrals({ ...none, umamiSite: "u-1" }, period);
    expect(rows.ga4).toHaveBeenCalledWith("properties/1", "2026-10-01", "2026-10-28");
    expect(rows.plausible).toHaveBeenCalledWith("made-up.example", "2026-10-01", "2026-10-28");
    expect(rows.umami).toHaveBeenCalledWith("u-1", "2026-10-01", "2026-10-28");
  });

  it("has nothing to say for a project with no source", async () => {
    expect(await aiReferrals(none, period)).toEqual({ state: "none" });
  });

  it("says why a source couldn't be read, rather than showing zero", async () => {
    rows.ga4.mockRejectedValue(new GoogleQuotaError("quota"));
    expect(await aiReferrals({ ...none, ga4Property: "properties/1" }, period)).toEqual({ state: "error", source: "ga4", period, message: "GA4 is limiting requests right now. Try again in a few minutes." });
  });
});

describe("referralProblem", () => {
  it("puts each kind of failure in words", () => {
    expect(referralProblem("ga4", new GoogleNotConnectedError("reauth_required"))).toBe("GA4 needs reconnecting before SEOpen can read its visits from AI assistants.");
    expect(referralProblem("plausible", new PlausibleAccessError("plan"))).toMatch(/Stats API/);
    expect(referralProblem("plausible", new PlausibleAccessError("site"))).toBe("Plausible didn't let SEOpen read this project's visits by source.");
    expect(referralProblem("umami", new UmamiUnreachableError("SEOpen couldn't reach your Umami server."))).toBe("SEOpen couldn't reach your Umami server.");
    expect(referralProblem("posthog", new Error("boom"))).toBe("PostHog didn't answer, so visits from AI assistants can't be shown. Try again in a minute.");
  });
});

describe("aiSentence", () => {
  it("compares with organic search when there is some", () => {
    expect(aiSentence(0, 100)).toBe("No sessions came from AI assistants in this period.");
    expect(aiSentence(1, 0)).toBe("1 session came from AI assistants in this period.");
    expect(aiSentence(12, 340)).toBe("12 sessions came from AI assistants in this period, against 340 from organic search.");
  });
});
