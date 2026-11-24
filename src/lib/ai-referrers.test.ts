import { describe, expect, it } from "vitest";
import { AI_ASSISTANT_NAMES, AI_ASSISTANTS, AI_REFERRER_HOSTS, aiAssistantFor, aiAssistantForVisit, groupAiReferrals } from "./ai-referrers";

const id = (v: string | null | undefined) => aiAssistantFor(v)?.id ?? null;

describe("aiAssistantFor", () => {
  it("knows each assistant's hosts and their subdomains", () => {
    expect(id("chatgpt.com")).toBe("chatgpt");
    expect(id("chat.openai.com")).toBe("chatgpt");
    expect(id("perplexity.ai")).toBe("perplexity");
    expect(id("www.perplexity.ai")).toBe("perplexity");
    expect(id("gemini.google.com")).toBe("gemini");
    expect(id("claude.ai")).toBe("claude");
    expect(id("copilot.microsoft.com")).toBe("copilot");
    expect(id("chat.deepseek.com")).toBe("deepseek");
    for (const host of AI_REFERRER_HOSTS) expect(id(host)).not.toBeNull();
  });

  it("reads URLs, ports, case and a trailing dot", () => {
    expect(id("https://www.perplexity.ai/search?q=x")).toBe("perplexity");
    expect(id("HTTPS://ChatGPT.com/")).toBe("chatgpt");
    expect(id("claude.ai:443")).toBe("claude");
    expect(id("chatgpt.com.")).toBe("chatgpt");
  });

  it("knows the names tools and utm_source use", () => {
    expect(id("ChatGPT")).toBe("chatgpt");
    expect(id(" perplexity ")).toBe("perplexity");
    expect(id("Microsoft Copilot")).toBe("copilot");
    expect(id("Le Chat")).toBe("mistral");
    expect(id("Meta AI")).toBe("meta-ai");
  });

  it("doesn't take search engines, look-alikes or parts of a name", () => {
    for (const v of ["google.com", "www.google.com", "bing.com", "duckduckgo.com", "notchatgpt.com", "chatgpt.com.evil.example", "openai.com", "mail.google.com", "Google", "chat", "", null, undefined]) {
      expect(id(v)).toBeNull();
    }
  });

  it("has unique ids and hosts, and names every assistant in its copy", () => {
    expect(new Set(AI_ASSISTANTS.map((a) => a.id)).size).toBe(AI_ASSISTANTS.length);
    expect(new Set(AI_REFERRER_HOSTS).size).toBe(AI_REFERRER_HOSTS.length);
    for (const a of AI_ASSISTANTS) expect(AI_ASSISTANT_NAMES).toContain(a.name);
  });
});

describe("groupAiReferrals", () => {
  it("adds up each assistant's sessions and drops other sources", () => {
    const g = groupAiReferrals([
      { sources: ["chatgpt.com"], sessions: 10, engagedSessions: 6 },
      { sources: ["chat.openai.com"], sessions: 2, engagedSessions: 1 },
      { sources: ["google"], sessions: 500, engagedSessions: 300 },
      { sources: ["perplexity.ai"], sessions: 4, engagedSessions: 4 },
      { sources: ["(direct)"], sessions: 90, engagedSessions: 10 },
    ]);
    expect(g.sessions).toBe(16);
    expect(g.engagedSessions).toBe(11);
    expect(g.assistants).toEqual([
      { id: "chatgpt", name: "ChatGPT", sessions: 12, engagedSessions: 7, seenAs: ["chatgpt.com", "chat.openai.com"] },
      { id: "perplexity", name: "Perplexity", sessions: 4, engagedSessions: 4, seenAs: ["perplexity.ai"] },
    ]);
  });

  it("lets the first matching source decide, so a utm_source counts when the referrer is missing", () => {
    const g = groupAiReferrals([
      { sources: [null, "chatgpt.com"], sessions: 3, engagedSessions: 1 },
      { sources: ["claude.ai", "chatgpt.com"], sessions: 2, engagedSessions: 2 },
      { sources: ["news.example.com", null], sessions: 8, engagedSessions: 8 },
    ]);
    expect(g.assistants.map((a) => [a.id, a.sessions])).toEqual([
      ["chatgpt", 3],
      ["claude", 2],
    ]);
  });

  it("ignores empty rows and caps engaged at sessions", () => {
    const g = groupAiReferrals([
      { sources: ["claude.ai"], sessions: 0, engagedSessions: 0 },
      { sources: ["claude.ai"], sessions: 2, engagedSessions: 5 },
    ]);
    expect(g).toEqual({ sessions: 2, engagedSessions: 2, assistants: [{ id: "claude", name: "Claude", sessions: 2, engagedSessions: 2, seenAs: ["claude.ai"] }] });
    expect(groupAiReferrals([])).toEqual({ sessions: 0, engagedSessions: 0, assistants: [] });
  });
});

describe("aiAssistantForVisit", () => {
  it("reads the referrer first, then the utm_source or ref", () => {
    expect(aiAssistantForVisit({ referrerHost: "chatgpt.com", source: null })?.name).toBe("ChatGPT");
    expect(aiAssistantForVisit({ referrerHost: null, source: "perplexity" })?.name).toBe("Perplexity");
    expect(aiAssistantForVisit({ referrerHost: "claude.ai", source: "chatgpt.com" })?.name).toBe("Claude");
    expect(aiAssistantForVisit({ referrerHost: "www.reddit.com", source: "newsletter" })).toBeNull();
    expect(aiAssistantForVisit({})).toBeNull();
  });
});
