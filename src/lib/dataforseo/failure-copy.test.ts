import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendRefusedError } from "@/lib/billing/errors";
import { ceilingRefusal, creditsRefusal, FREE_PLAN_REFUSAL, PLATFORM_REFUSAL, stateRefusal } from "@/lib/billing/spend";
import { LOCKED_REFUSAL } from "@/lib/billing/workspace";
import { OpError } from "@/lib/ops";
import { GoogleAccessError } from "@/modules/google/auth";
import { GoogleNotConnectedError, GoogleQuotaError } from "@/modules/google/types";
import { PlausibleAccessError, PlausibleHttpError, PlausibleNotConnectedError, PlausibleQuotaError } from "@/modules/plausible/types";
import { PosthogAccessError, PosthogNotConnectedError, PosthogQuotaError } from "@/modules/posthog/types";
import { BudgetExceededError, DataForSEOError } from "./client";
import { AI_RUN_NO_ANSWERS, AI_RUN_TIMED_OUT, aiRunFailure, CRAWL_NOT_QUEUED, unknownFailureNextStep, plainActionFailure, plainAiFailure, plainAioFailure, plainCallFailure, plainCheckReason, plainCrawlFailure, plainCrawlSummary, plainFailure, plainFailureLine, plainLighthouseFailure, plainLocalFailure, plainNextStep, plainRankFailure, plainRankRunFailure, storedFailureKind, storedFailure, syncErrorDetail } from "./failure-copy";

// Most of this file checks the hosted service's words; "on a self-hosted copy" at the end checks the others.
beforeEach(() => vi.stubEnv("SEOPEN_HAS_SITE", "1"));
afterEach(() => vi.unstubAllEnvs());

const VENDOR = /dataforseo|http \d|on_page|task_post|internal error/i;

describe("plainFailure", () => {
  it("says which data didn't come back, from the endpoint", () => {
    expect(plainFailure(new DataForSEOError("DataForSEO HTTP 500 on dataforseo_labs/google/ranked_keywords/live", 500, "dataforseo_labs/google/ranked_keywords/live"))).toEqual({
      title: "Google data didn't come back",
      message: "Try again in a minute.",
      retry: true,
    });
    expect(plainFailure(new DataForSEOError("x", 500, "serp/google/organic/live/advanced")).title).toBe("Google data didn't come back");
    expect(plainFailure(new DataForSEOError("x", 500, "keywords_data/google_ads/search_volume/live")).title).toBe("Google data didn't come back");
    expect(plainFailure(new DataForSEOError("x", 500, "backlinks/summary/live")).title).toBe("Backlink data didn't come back");
    expect(plainFailure(new DataForSEOError("x", 500, "on_page/lighthouse")).title).toBe("Site audit data didn't come back");
    expect(plainFailure(new DataForSEOError("x", 500, "ai_optimization/llm_mentions/search/live")).title).toBe("AI answer data didn't come back");
  });

  it("reads a task's path, which starts with the API version", () => {
    expect(plainFailure(new DataForSEOError("Internal Error.", 50000, "v3/backlinks/summary/live")).title).toBe("Backlink data didn't come back");
  });

  it("doesn't guess a source when the endpoint is unknown", () => {
    expect(plainFailure(new DataForSEOError("DataForSEO returned no task", 0, "")).title).toBe("The data didn't come back");
  });

  it("offers no retry when the request itself was rejected", () => {
    expect(plainFailure(new DataForSEOError("Invalid Field: 'target'.", 40501, "backlinks/summary/live"))).toEqual({
      title: "That lookup didn't work",
      message: "Check the domain or keyword, then run it again.",
      retry: false,
    });
  });

  it("never prints the vendor's text", () => {
    const failure = plainFailure(new DataForSEOError("DataForSEO HTTP 500 on on_page/task_post", 500, "on_page/task_post"));
    expect(`${failure.title} ${failure.message}`).not.toMatch(/HTTP|task_post|DataForSEO/);
  });

  it("keeps the reconnect wording of a lost connection, with no retry", () => {
    expect(plainFailure(new GoogleNotConnectedError("reauth_required"))).toEqual({ title: "Google isn't connected", message: "Google access was revoked or expired. Reconnect Google.", retry: false });
    expect(plainFailure(new GoogleNotConnectedError("not_connected")).message).toBe("No Google account is connected.");
    expect(plainFailure(new PosthogNotConnectedError("reauth_required"))).toEqual({ title: "PostHog isn't connected", message: "PostHog needs reconnecting.", retry: false });
    expect(plainFailure(new PosthogNotConnectedError("not_connected")).message).toBe("PostHog is not connected.");
  });

  it("says where to look when Google refuses a property, with no retry and without Google's text", () => {
    expect(plainFailure(new GoogleAccessError("User does not have sufficient permission for site 'sc-domain:a.com'."))).toEqual({
      title: "No access to that property",
      message: "This Google account can't reach that property. Check its access in Google, or reconnect Google.",
      retry: false,
    });
  });

  it("puts Plausible's failures in plain words, with a retry only when one can work", () => {
    expect(plainFailure(new PlausibleNotConnectedError("reauth_required"))).toEqual({ title: "Plausible isn't connected", message: "Plausible needs reconnecting.", retry: false });
    expect(plainFailure(new PlausibleAccessError("site"))).toMatchObject({ title: "No access to that Plausible site", retry: false });
    expect(plainFailure(new PlausibleAccessError("plan"))).toMatchObject({ message: expect.stringMatching(/Business plan/), retry: false });
    expect(plainFailure(new PlausibleQuotaError("Too many API requests"))).toEqual({ title: "Plausible is limiting requests", message: "Try again in a few minutes.", retry: true });
    expect(plainFailure(new PlausibleHttpError(500, "made-up vendor text"))).toEqual({ title: "Something went wrong", message: "This part of the page didn't load. Try again in a minute.", retry: true });
  });

  it("offers no retry when PostHog refuses a project, and points at a reconnect", () => {
    expect(plainFailure(new PosthogAccessError())).toEqual({ title: "No access to that PostHog project", message: "This PostHog connection can't reach that project. Reconnect and grant it.", retry: false });
  });

  it.each([
    ["no money on the account", 40204],
    ["a bad login", 40100],
    ["an unverified account", 40104],
    ["payment required", 40200],
    ["a paused account", 40201],
    ["the dashboard's cost limit", 40203],
    ["an address not on the list", 40207],
    ["a blocked account", 40208],
    ["no funds", 40210],
    ["HTTP 402", 402],
  ])("offers no retry when our account can't make the call: %s", (_why, code) => {
    const failure = plainFailure(new DataForSEOError("x", code, "backlinks/summary/live"));
    expect(failure).toEqual({ title: "Backlink data isn't available right now", message: "It's a problem on our side, and there's nothing for you to fix.", retry: false });
    expect(`${failure.title} ${failure.message}`).not.toMatch(VENDOR);
  });

  it("offers no retry when no credentials are set", () => {
    expect(plainFailure(new DataForSEOError("DataForSEO credentials are missing", 0, "")).retry).toBe(false);
  });

  it.each([40202, 40209])("still offers a retry on a rate limit: %s", (code) => {
    expect(plainFailure(new DataForSEOError("Rate limit", code, "backlinks/summary/live")).retry).toBe(true);
  });

  it.each([
    [40101, "Internal SE Server Error"],
    [40103, "Task execution failed"],
    [40106, "Partial results"],
  ])("says a failure that comes and goes didn't come back, and offers a retry: %s", (code, vendorText) => {
    const failure = plainFailure(new DataForSEOError(vendorText, code, "serp/google/organic/live/advanced"));
    expect(failure).toEqual({ title: "Google data didn't come back", message: "Try again in a minute.", retry: true });
    expect(`${failure.title} ${failure.message}`).not.toMatch(VENDOR);
    expect(`${failure.title} ${failure.message}`).not.toContain("on our side");
    expect(`${failure.title} ${failure.message}`).not.toContain(vendorText);
  });

  it("hides environment details of a connection that isn't set up", () => {
    expect(plainFailure(new GoogleNotConnectedError("not_configured")).message).toBe("Google sign-in isn't set up on this server.");
    expect(plainFailure(new PosthogNotConnectedError("not_configured")).message).toBe("PostHog sign-in isn't set up on this server.");
  });

  it("asks for a few minutes when a service is limiting requests", () => {
    expect(plainFailure(new GoogleQuotaError("Quota exceeded for quota metric"))).toEqual({ title: "Google is limiting requests", message: "Try again in a few minutes.", retry: true });
    expect(plainFailure(new PosthogQuotaError("Rate limit: 240/min"))).toEqual({ title: "PostHog is limiting requests", message: "Try again in a few minutes.", retry: true });
  });

  it("hides anything else, including a non-error value", () => {
    const general = { title: "Something went wrong", message: "This part of the page didn't load. Try again in a minute.", retry: true };
    expect(plainFailure(new Error('relation "users" does not exist'))).toEqual(general);
    expect(plainFailure("PostHog API error 500")).toEqual(general);
  });
});

describe("plainFailureLine", () => {
  it("says what failed and what to do, without the vendor's text", () => {
    const line = plainFailureLine(new DataForSEOError("DataForSEO HTTP 502 on serp/google/maps/live/advanced", 502, "serp/google/maps/live/advanced"));
    expect(line).toBe("Google data didn't come back. Try again in a minute.");
    expect(line).not.toMatch(VENDOR);
  });

  it("doesn't talk about a page when it can't name the failure", () => {
    expect(plainFailureLine(new Error('relation "users" does not exist'))).toBe("Something went wrong. Try again in a minute.");
  });
});

describe("plainNextStep", () => {
  it("names the next step for a failure it knows", () => {
    expect(plainNextStep(new GoogleAccessError("User does not have sufficient permission for site 'sc-domain:a.com'."), "x")).toBe("This Google account can't reach that property. Check its access in Google, or reconnect Google.");
    expect(plainNextStep(new GoogleNotConnectedError("reauth_required"), "x")).toBe("Google access was revoked or expired. Reconnect Google.");
  });

  it("uses the caller's words for anything else", () => {
    expect(plainNextStep(new Error("Request failed with status code 500"), "Sync didn't finish.")).toBe("Sync didn't finish.");
  });
});

describe("plainActionFailure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the words of a refusal, an OpError and the internal cap, and logs none of them", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(plainActionFailure(new OpError("Enter the business name and its city."), "t")).toBe("Enter the business name and its city.");
    const refusal = stateRefusal({ status: "active", stripeCustomerId: "cus_1", plan: "starter" } as never, false)!;
    expect(plainActionFailure(new SpendRefusedError(1, refusal), "t")).toBe(refusal.message);
    expect(plainActionFailure(new BudgetExceededError(10, 10, 1, "Monthly API cap reached"), "t")).toBe("Monthly API cap reached");
    expect(log).not.toHaveBeenCalled();
  });

  it("logs the vendor's text and shows plain words", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new DataForSEOError("DataForSEO HTTP 502 on serp/google/maps/live/advanced", 502, "serp/google/maps/live/advanced");
    expect(plainActionFailure(error, "local.find")).toBe("Google data didn't come back. Try again in a minute.");
    expect(log).toHaveBeenCalledWith("[local.find]", error);
  });

  it("hides anything else too", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(plainActionFailure(new Error('relation "users" does not exist'), "t")).toBe("Something went wrong. Try again in a minute.");
  });
});

describe("syncErrorDetail", () => {
  const failed = { status: "error", message: "This sync didn't finish.", lastError: "User does not have sufficient permission" };

  it("shows the raw text to the internal plan only", () => {
    expect(syncErrorDetail(failed, true)).toBe("User does not have sufficient permission");
    expect(syncErrorDetail(failed, false)).toBeNull();
  });

  it("doesn't repeat the message", () => {
    expect(syncErrorDetail({ status: "reauth", message: "PostHog needs reconnecting", lastError: "PostHog needs reconnecting" }, true)).toBeNull();
    expect(syncErrorDetail({ status: "reauth", message: "PostHog needs reconnecting.", lastError: "PostHog needs reconnecting" }, true)).toBeNull();
  });

  it("stays quiet once the sync is fine, or with nothing stored", () => {
    expect(syncErrorDetail({ ...failed, status: "ok" }, true)).toBeNull();
    expect(syncErrorDetail({ ...failed, lastError: null }, true)).toBeNull();
  });
});

describe("stored failures", () => {
  const ws = { status: "active", stripeCustomerId: "cus_1", trialBlockedReason: "Your card was declined." };
  const customerRefusals = [
    stateRefusal({ ...ws, plan: "trial", status: "suspended" } as never, true),
    stateRefusal({ ...ws, plan: "none", stripeCustomerId: null } as never, true),
    stateRefusal({ ...ws, plan: "none" } as never, true),
    stateRefusal({ ...ws, plan: "starter" } as never, false),
    stateRefusal({ ...ws, plan: "trial" } as never, true),
    ceilingRefusal({ plan: "trial" } as never, 3),
    ceilingRefusal({ plan: "starter" } as never, 30),
    creditsRefusal({ plan: "trial" } as never, 1),
    creditsRefusal({ plan: "starter" } as never, 10),
    PLATFORM_REFUSAL,
    FREE_PLAN_REFUSAL,
    LOCKED_REFUSAL,
  ].map((r) => r!.message);

  it.each(customerRefusals)("shows a refusal as it was written: %s", (message) => {
    expect(plainCrawlFailure(message)).toEqual({ message, retry: false });
    expect(plainLighthouseFailure(message)).toBe(message);
    expect(plainAiFailure(message)).toBe(message);
    expect(plainCheckReason(message)).toBe(message);
    expect(plainRankFailure(message)).toBe(message);
  });

  it.each(["DataForSEO HTTP 502 on ai_optimization/chat_gpt/llm_responses/task_post", "50000 Internal Error.", "40202 Rate limit", "40209 Too many requests", "DataForSEO returned no task", ""])("hides an AI run's vendor text: %s", (raw) => {
    const message = plainAiFailure(raw);
    expect(message).toBe("The AI answer service had a problem. Run it again in a minute.");
    expect(message).not.toMatch(VENDOR);
  });

  it("doesn't promise a retry when the service rejected the prompt", () => {
    const message = plainAiFailure("40501 Invalid Field");
    expect(message).toBe("The AI answer service rejected this prompt. Running it again won't help unless the wording changes.");
    expect(message).not.toMatch(VENDOR);
  });

  it.each(["40100 Not authorized", "40200 Payment required", "40204 Subscription required", "DataForSEO HTTP 402 on ai_optimization/chat_gpt/llm_responses/live", "DataForSEO credentials are missing from .env.local"])("doesn't promise a retry when our account can't make the call: %s", (raw) => {
    const message = plainAiFailure(raw);
    expect(message).toBe("The AI answer service isn't available right now. It's a problem on our side, and there's nothing for you to fix.");
    expect(message).not.toMatch(VENDOR);
  });

  it.each(["40101 Internal SE Server Error", "40103 Task execution failed", "40106 Partial results"])("offers another go at what was stored after a failure that comes and goes: %s", (raw) => {
    expect(plainAiFailure(raw)).toBe("The AI answer service had a problem. Run it again in a minute.");
    expect(plainCrawlFailure(raw)).toEqual({ message: "The crawl service had a problem, so this crawl didn't finish. Start a new one in a minute.", retry: true });
    expect(plainLighthouseFailure(raw)).toBe("Lighthouse didn't come back. Run it again in a minute.");
  });

  it("copes with a failed AI run with no stored text", () => {
    expect(plainAiFailure(null)).toBe("The AI answer service had a problem. Run it again in a minute.");
  });

  it("says an AI run whose job was lost didn't start", () => {
    expect(plainAiFailure("Posting never finished")).toBe("This run didn't start.");
  });

  it("puts an AI answer's own failures in plain words", () => {
    expect(plainAiFailure("0 Timed out after 72 h")).toBe("No answer came back in time. Run it again.");
    expect(plainAiFailure("Timed out")).toBe("No answer came back in time. Run it again.");
    expect(plainAiFailure("Run stopped before this task was posted")).toBe("The run stopped before this prompt was sent.");
  });

  it.each(["Google Maps returned no listings here", "No result after 3 days", "Could not queue the check"])("keeps SEOpen's own check reason: %s", (own) => {
    expect(plainCheckReason(own)).toBe(own);
    expect(plainRankFailure(own)).toBe(own);
  });

  it.each(["40501 Invalid Field", "50000 Internal Error.", "No answer from DataForSEO", "DataForSEO HTTP 500 on serp/google/maps/task_post", "Not posted"])("drops a check's other text: %s", (raw) => {
    expect(plainCheckReason(raw)).toBeNull();
    expect(plainRankFailure(raw)).toBe("Some searches in this check didn't come back.");
    expect(plainRankFailure(raw)).not.toMatch(/again/i);
  });

  it("says a check that lost its job didn't start, not that searches didn't come back", () => {
    expect(plainRankFailure("Posting never finished")).toBe("This check didn't start.");
  });

  it("has nothing to say about a check with no stored error", () => {
    expect(plainCheckReason(null)).toBeNull();
    expect(plainRankFailure(null)).toBe("");
  });

  it("puts a crawl's stop reason in plain words, without the vendor or the status code", () => {
    expect(plainCrawlFailure("DataForSEO's crawler could not reach the site. The host may be blocking its IP range, or timing out. (site_unreachable)")).toEqual({
      message: "The crawler couldn't reach the site. The host may be blocking it or timing out.",
      retry: true,
    });
    expect(plainCrawlFailure("robots.txt forbids crawling the site. (forbidden_robots)").message).toBe("robots.txt forbids crawling the site.");
    expect(plainCrawlFailure("The start page redirects too many times. (too_many_redirects)").message).toBe("The start page redirects too many times.");
    expect(plainCrawlFailure("The start page returned an error status, so the crawler stopped. (invalid_page_status_code)").message).toBe("The start page returned an error status, so the crawler stopped.");
    expect(plainCrawlFailure("The start page has a robots meta tag that forbids crawling. (forbidden_meta_tag)").message).toBe("The start page has a robots meta tag that forbids crawling.");
    expect(plainCrawlFailure("The start page sends an X-Robots-Tag header that forbids crawling. (forbidden_http_header)").message).toBe("The start page sends an X-Robots-Tag header that forbids crawling.");
  });

  it("keeps SEOpen's own crawl failures as they are", () => {
    for (const own of ["The crawl stopped: something new.", "The crawl did not finish within 12 hours.", "Cancelled before it started"]) {
      expect(plainCrawlFailure(own)).toEqual({ message: own, retry: true });
    }
  });

  it.each(["DataForSEO HTTP 500 on on_page/task_post", "Internal Error.", "No task returned", "Task Not Found (unknown_code)", ""])("hides a crawl's vendor text: %s", (raw) => {
    const { message, retry } = plainCrawlFailure(raw);
    expect(message).toBe("The crawl service had a problem, so this crawl didn't finish. Start a new one in a minute.");
    expect(message).not.toMatch(VENDOR);
    expect(retry).toBe(true);
  });

  it("doesn't offer a new crawl that can't work", () => {
    expect(plainCrawlFailure("40501 Invalid Field")).toEqual({ message: "The crawl service rejected this crawl, so starting it again won't help. Check the project's domain.", retry: false });
    for (const raw of ["40204 Subscription required", "DataForSEO HTTP 402 on on_page/task_post", "DataForSEO credentials are missing from .env.local"]) {
      expect(plainCrawlFailure(raw)).toEqual({ message: "The crawl service isn't available right now. It's a problem on our side, and there's nothing for you to fix.", retry: false });
    }
  });

  it("stores a task failure with its code, so a failure a retry can't fix doesn't offer one", () => {
    const rejected = new DataForSEOError("Invalid Field.", 40501, "on_page/task_post");
    expect(storedFailure(rejected)).toBe("40501 Invalid Field.");
    expect(plainCrawlFailure(storedFailure(rejected)).retry).toBe(false);
    expect(plainLighthouseFailure(storedFailure(new DataForSEOError("Invalid Field.", 40501, "on_page/lighthouse")))).toBe("Lighthouse rejected this page, so running it again won't help. Check the page's address.");
    expect(plainCrawlFailure(storedFailure(new DataForSEOError("Internal Error.", 50000, "on_page/task_post"))).retry).toBe(true);
  });

  it("stores other failures as they are", () => {
    expect(storedFailure(new DataForSEOError("DataForSEO HTTP 402 on on_page/task_post", 402, "on_page/task_post"))).toBe("DataForSEO HTTP 402 on on_page/task_post");
    expect(storedFailure(new DataForSEOError("No task returned", 0, "on_page/task_post"))).toBe("No task returned");
    expect(storedFailure(new Error("The crawl did not finish within 12 hours."))).toBe("The crawl did not finish within 12 hours.");
    expect(storedFailure("text")).toBe("text");
  });

  it("offers a new crawl after one that couldn't be queued", () => {
    expect(plainCrawlFailure(CRAWL_NOT_QUEUED)).toEqual({ message: CRAWL_NOT_QUEUED, retry: true });
  });

  it("reads no vendor code out of SEOpen's own crawl failure", () => {
    expect(plainCrawlFailure("The crawl stopped: the site said 403 Forbidden.")).toEqual({ message: "The crawl stopped: the site said 403 Forbidden.", retry: true });
  });

  it("doesn't ask for another Lighthouse run that can't work", () => {
    expect(plainLighthouseFailure("DataForSEO HTTP 402 on on_page/lighthouse/live/json")).toBe("Lighthouse isn't available right now. It's a problem on our side, and there's nothing for you to fix.");
    expect(plainLighthouseFailure("40501 Invalid Field")).toBe("Lighthouse rejected this page, so running it again won't help. Check the page's address.");
  });

  it("copes with a failed crawl with no stored text", () => {
    expect(plainCrawlFailure(null).retry).toBe(true);
    expect(plainLighthouseFailure(null)).toBe("Lighthouse didn't come back. Run it again in a minute.");
  });

  it("says a stale Lighthouse run ran out of time", () => {
    expect(plainLighthouseFailure("Timed out")).toBe("Lighthouse didn't finish in time. Run it again.");
  });

  it.each(["DataForSEO HTTP 500 on on_page/lighthouse/live/json", "Lighthouse returned no result", "Internal Error."])("hides Lighthouse's vendor text: %s", (raw) => {
    expect(plainLighthouseFailure(raw)).toBe("Lighthouse didn't come back. Run it again in a minute.");
  });
});

describe("whole checks that failed", () => {
  it("say a check that never got its searches out in plain words", () => {
    expect(plainRankRunFailure("Posting never finished")).toBe("This check didn't start.");
    expect(plainLocalFailure("Posting never finished")).toBe("This check didn't start.");
  });

  it("never pass on the vendor's text", () => {
    for (const raw of ["40501 Invalid Field", "No answer from DataForSEO", "DataForSEO HTTP 500 on serp/google/maps/task_post"]) {
      expect(plainRankRunFailure(raw)).not.toMatch(/DataForSEO|40501/);
      expect(plainLocalFailure(raw)).not.toMatch(/DataForSEO|40501/);
    }
  });

  it("sort a stored failure into what a page can offer", () => {
    expect(storedFailureKind(PLATFORM_REFUSAL.message)).toBe("refusal");
    expect(storedFailureKind("40501 Invalid Field")).toBe("rejected");
    expect(storedFailureKind("Timed out")).toBe("other");
    expect(storedFailureKind(null)).toBe("other");
  });
});

describe("an AI run with no answers", () => {
  it("says what happened in plain words, whatever the answers' errors were", () => {
    expect(aiRunFailure([])).toBe(AI_RUN_NO_ANSWERS);
    expect(aiRunFailure(["40501 Invalid Field", "40501 Invalid Field"])).not.toMatch(/40501/);
    expect(plainAiFailure(aiRunFailure(["Timed out after 72 h"]))).toMatch(/no answer came back in time/i);
    expect(plainAiFailure(AI_RUN_NO_ANSWERS)).not.toMatch(/DataForSEO/);
  });

  it("knows which can't be helped by running again", () => {
    expect(storedFailureKind(aiRunFailure(["40501 Invalid Field"]))).toBe("rejected");
    expect(storedFailureKind(aiRunFailure(["40200 Payment Required"]))).toBe("our-side");
    expect(storedFailureKind(AI_RUN_NO_ANSWERS)).toBe("other");
    expect(storedFailureKind(AI_RUN_TIMED_OUT)).toBe("other");
  });
});

describe("the crawl's stop line on a summary", () => {
  it("passes no vendor status up", () => {
    expect(plainCrawlSummary("The crawl stopped: terminated by server").message).toBe("The crawl stopped before it reached any pages.");
    expect(plainCrawlSummary("Timed out")).toEqual(plainCrawlFailure("Timed out"));
  });
});

describe("a failed call the ledger kept", () => {
  it("says it as it would have been said in front of the customer, from the status and the endpoint", () => {
    expect(plainCallFailure(402, "backlinks/summary/live")).toEqual({
      message: "Backlink data isn't available right now. It's a problem on our side, and there's nothing for you to fix.",
      retry: false,
    });
    expect(plainCallFailure(500, "ai_optimization/llm_mentions/multi_target_metrics/live")).toEqual({ message: "AI answer data didn't come back. Try again in a minute.", retry: true });
    expect(plainCallFailure(40200, "backlinks/summary/live").retry).toBe(false);
  });

  it("never passes on the vendor's text", () => {
    for (const code of [402, 500, 40200, 40501]) expect(plainCallFailure(code, "backlinks/summary/live").message).not.toMatch(VENDOR);
  });
});

describe("a failed AI Overview check", () => {
  const OUR_SIDE = "Google data isn't available right now. It's a problem on our side, and there's nothing for you to fix.";

  it("says what happened in plain words", () => {
    expect(plainAioFailure("DataForSEO HTTP 402 on serp/google/organic/task_post")).toBe(OUR_SIDE);
    expect(plainAioFailure("40200 Payment Required.")).toBe(OUR_SIDE);
    expect(plainAioFailure("Run stopped before this task was posted")).toBe("The run stopped before these keywords were checked.");
    expect(plainAioFailure("Timed out")).toBe("Google's results didn't come back in time.");
    expect(plainAioFailure("50000 Internal Error.")).toBe("Google data didn't come back. The next run checks again.");
  });

  it("keeps a refusal's own words, and never the vendor's", () => {
    expect(plainAioFailure(FREE_PLAN_REFUSAL.message)).toBe(FREE_PLAN_REFUSAL.message);
    for (const stored of ["DataForSEO HTTP 402 on serp/google/organic/task_post", "40501 Invalid Field: 'keyword'.", "50000 Internal Error."]) expect(plainAioFailure(stored)).not.toMatch(VENDOR);
  });
});

describe("on a self-hosted copy", () => {
  beforeEach(() => vi.stubEnv("SEOPEN_HAS_SITE", ""));

  it("says DataForSEO isn't set up, and which settings to add, when there's no login", () => {
    const failure = plainFailure(new DataForSEOError("DataForSEO credentials are missing: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD aren't set", 0, ""));
    expect(failure).toEqual({
      title: "DataForSEO isn't set up yet",
      message: "Add your DataForSEO API login and password to DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in the env file, then restart SEOpen (in Docker: docker compose up -d).",
      retry: false,
    });
  });

  it.each([
    [40100, /API password from https:\/\/app\.dataforseo\.com\/api-access/],
    [401, /API password/],
    [40200, /out of funds/],
    [40210, /out of funds/],
    [402, /out of funds/],
    [40203, /daily spend limit/],
    [40104, /refused the account \(code 40104\)/],
    [403, /refused the account \(code 403\)/],
  ])("names the fix for an account problem: %s", (code, fix) => {
    const failure = plainFailure(new DataForSEOError("x", code, "backlinks/summary/live"));
    expect(failure.title).toBe("Backlink data isn't available right now");
    expect(failure.message).toMatch(fix);
    expect(failure.retry).toBe(false);
  });

  it("names the fix in stored failures too", () => {
    expect(plainCrawlFailure("DataForSEO HTTP 402 on on_page/task_post").message).toBe(
      "The crawl service isn't available right now. The DataForSEO account is out of funds. Add funds at https://app.dataforseo.com, then try again.",
    );
    expect(plainAiFailure(aiRunFailure(["40100 Not authorized"]))).toMatch(/DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in the env file/);
  });

  it("says which settings turn on Google and PostHog", () => {
    expect(plainFailure(new GoogleNotConnectedError("not_configured")).message).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the env file/);
    expect(plainFailure(new PosthogNotConnectedError("not_configured")).message).toMatch(/BETTER_AUTH_URL/);
  });

  it("points at the server log for a failure it can't name", () => {
    expect(unknownFailureNextStep()).toBe("The reason is in the server log.");
  });

  it("never says the problem is on SEOpen's side", () => {
    const lines = [
      plainFailureLine(new DataForSEOError("DataForSEO credentials are missing", 0, "")),
      ...[40100, 40200, 40203, 40204, 402, 403].map((code) => plainFailureLine(new DataForSEOError("x", code, "serp/google/organic/live/advanced"))),
      plainLighthouseFailure("DataForSEO HTTP 402 on on_page/lighthouse/live/json"),
      plainAioFailure("40200 Payment required"),
      plainRankRunFailure("40100 Not authorized"),
      plainLocalFailure("40210 Insufficient funds"),
      plainCallFailure(402, "backlinks/summary/live").message,
    ];
    for (const line of lines) expect(line).not.toMatch(/our side|nothing for you to fix/);
  });
});
