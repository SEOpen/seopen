import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainFailure } from "@/lib/dataforseo/failure-copy";
import { livePosthogApis } from "./api";
import { parseSourceRows, sourceSessionsQuery } from "./hogql";
import { PosthogAccessError } from "./types";

const reject = vi.fn();
vi.mock("./account", () => ({
  fixtureMode: () => false,
  posthogAccessToken: async () => ({ token: "pha_test", account: { id: 1, workspaceId: 7, region: "us", scopedTeams: [] } }),
  rejectPosthogToken: (...a: unknown[]) => reject(...a),
}));

const forbidden = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("a PostHog 403", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reject.mockReset();
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for a reconnect with no Retry, since the same call can't work", async () => {
    const err = await livePosthogApis(7, forbidden({ detail: "You don't have access to the project." }))
      .project(1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PosthogAccessError);
    expect(plainFailure(err)).toEqual({ title: "No access to that PostHog project", message: "This PostHog connection can't reach that project. Reconnect and grant it.", retry: false });
  });

  it("keeps PostHog's reason in the logs", async () => {
    await livePosthogApis(7, forbidden({ detail: "You don't have access to the project." }))
      .project(1)
      .catch(() => {});
    expect(log).toHaveBeenCalledWith("[posthog] 403:", "You don't have access to the project.");
  });

  it("leaves the stored token alone, since it may still reach other projects", async () => {
    await livePosthogApis(7, forbidden({})).project(1).catch(() => {});
    expect(reject).not.toHaveBeenCalled();
  });
});

describe("sessions by source, for AI assistants", () => {
  it("groups every session in the range by entry referrer and utm_source, with no channel filter", () => {
    const q = sourceSessionsQuery("2026-10-01", "2026-10-28");
    expect(q).toContain("GROUP BY referrer, utm_source");
    expect(q).toContain("lower($entry_referring_domain)");
    expect(q).toContain("lower($entry_utm_source)");
    expect(q).toContain("toDate($start_timestamp) >= toDate('2026-10-01') AND toDate($start_timestamp) <= toDate('2026-10-28')");
    expect(q).not.toContain("$channel_type");
    expect(() => sourceSessionsQuery("2026-10-01'; DROP", "2026-10-28")).toThrow(/Bad date range/);
  });

  it("reads PostHog's $direct as no referrer, so the utm_source decides", () => {
    expect(parseSourceRows([["$direct", "chatgpt.com", 5, 2], ["perplexity.ai", null, "3", "1"]])).toEqual([
      { sources: [null, "chatgpt.com"], sessions: 5, engagedSessions: 2 },
      { sources: ["perplexity.ai", null], sessions: 3, engagedSessions: 1 },
    ]);
  });

  it("posts the query as HogQL to the project", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ results: [["claude.ai", null, 2, 2]] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    expect(await livePosthogApis(7, impl).sourceSessions(42, "2026-10-01", "2026-10-28")).toEqual([{ sources: ["claude.ai", null], sessions: 2, engagedSessions: 2 }]);
    expect(calls[0].url).toBe("https://us.posthog.com/api/projects/42/query/");
    expect(calls[0].body).toMatchObject({ query: { kind: "HogQLQuery" }, name: "seopen_sessions_by_source" });
  });
});
