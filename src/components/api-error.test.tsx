import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError, DataForSEOError, SpendRefusedError } from "@/lib/dataforseo/client";
import { currentWorkspace } from "@/lib/workspace/current";
import { GoogleAccessError } from "@/modules/google/auth";
import { PosthogNotConnectedError } from "@/modules/posthog/types";
import { ApiError } from "./api-error";

vi.mock("@/lib/workspace/current", () => ({ currentWorkspace: vi.fn() }));
vi.mock("@/components/plan-upgrade", () => ({ UpgradeNow: () => <button>Upgrade now</button> }));
vi.mock("@/components/ui/retry-button", () => ({ RetryButton: () => <button>Retry</button> }));

const signedIn = (plan: string) => vi.mocked(currentWorkspace).mockResolvedValue({ plan } as never);
const html = async (error: unknown) => renderToStaticMarkup(await ApiError({ error })).replaceAll("&#x27;", "'");
const vendor = new DataForSEOError("DataForSEO HTTP 500 on backlinks/summary/live", 500, "backlinks/summary/live");

describe("ApiError", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a customer plain words and Retry, and logs the vendor's text", async () => {
    signedIn("starter");
    const out = await html(vendor);
    expect(out).toContain("Backlink data didn't come back");
    expect(out).toContain("Try again in a minute.");
    expect(out).toContain("Retry");
    expect(out).not.toContain("DataForSEO");
    expect(log).toHaveBeenCalledWith("[api-error]", "500 backlinks/summary/live: DataForSEO HTTP 500 on backlinks/summary/live");
  });

  it("shows the internal workspace the raw text under the same title", async () => {
    signedIn("internal");
    const out = await html(vendor);
    expect(out).toContain("Backlink data didn't come back");
    expect(out).toContain("DataForSEO HTTP 500 on backlinks/summary/live");
    expect(out).toContain("Retry");
  });

  it("stays plain when the workspace can't be read", async () => {
    vi.mocked(currentWorkspace).mockRejectedValue(new Error("db down"));
    const out = await html(vendor);
    expect(out).toContain("Try again in a minute.");
    expect(out).not.toContain("DataForSEO");
  });

  it("offers no Retry when the same request would fail again", async () => {
    signedIn("starter");
    const out = await html(new DataForSEOError("Invalid Field: 'target'.", 40501, "backlinks/summary/live"));
    expect(out).toContain("Check the domain or keyword, then run it again.");
    expect(out).not.toContain("Retry");
    expect(out).not.toContain("Invalid Field");
  });

  it("offers no Retry when Google refuses the property, and hides Google's text", async () => {
    signedIn("starter");
    const out = await html(new GoogleAccessError("User does not have sufficient permission for site"));
    expect(out).toContain("This Google account can't reach that property. Check its access in Google, or reconnect Google.");
    expect(out).not.toContain("Retry");
    expect(out).not.toContain("sufficient permission");
    expect(log).toHaveBeenCalledWith("[api-error]", "User does not have sufficient permission for site");
  });

  it("asks for a reconnect, with no Retry, when PostHog refuses access", async () => {
    signedIn("starter");
    const out = await html(new PosthogNotConnectedError("reauth_required"));
    expect(out).toContain("PostHog needs reconnecting.");
    expect(out).not.toContain("Retry");
  });

  it("hides and logs an error from anywhere else", async () => {
    signedIn("starter");
    const out = await html(new Error('relation "users" does not exist'));
    expect(out).toContain("Something went wrong");
    expect(out).not.toContain("relation");
    expect(log).toHaveBeenCalledWith("[api-error]", 'relation "users" does not exist');
  });

  it("keeps a refusal's message and Upgrade now, with no Retry and no log", async () => {
    const message = "Your trial's allowance is used up. Upgrade now to keep going with your plan's full limits.";
    const out = await html(new SpendRefusedError(1, { code: "ceiling", message, upgradable: true }));
    expect(out).toContain("Monthly limit reached");
    expect(out).toContain(message);
    expect(out).toContain("<button>Upgrade now</button>");
    expect(out).not.toContain("Retry");
    expect(log).not.toHaveBeenCalled();
  });

  it("offers Upgrade now only on a refusal that carries it", async () => {
    const message = "All 100 research credits for this month are used.";
    const out = await html(new SpendRefusedError(1, { code: "credits", message, upgradable: false }));
    expect(out).toContain(message);
    expect(out).not.toContain("<button>Upgrade now</button>");
  });

  it("keeps the internal workspace's cap message", async () => {
    const out = await html(new BudgetExceededError(10, 10));
    expect(out).toContain("Monthly API cap reached");
    expect(out).toContain("DataForSEO monthly cap reached");
    expect(out).not.toContain("Retry");
  });
});
