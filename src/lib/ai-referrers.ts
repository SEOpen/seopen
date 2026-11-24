/**
 * The one list of AI assistants SEOpen groups visits under, as "AI assistants" (Analytics, MCP
 * get_analytics, a sign-up's first visit). Each assistant is known by the hosts its links come from
 * and by the names an analytics tool or a utm_source may call it. A host matches itself and anything
 * under it, so www.perplexity.ai is Perplexity. Pure, so it's unit-tested (ai-referrers.test.ts).
 *
 * The hosts are where each assistant's web app lives. ChatGPT also adds utm_source=chatgpt.com to
 * the links it shows, which a host match covers. Add an assistant here, never in a module.
 */

export interface AiAssistant {
  id: string;
  name: string;
  /** Hosts its visits come from. Each also matches its subdomains. */
  hosts: readonly string[];
  /** Other names for it in a source column or utm_source, matched whole and ignoring case. */
  names: readonly string[];
}

export const AI_ASSISTANTS: readonly AiAssistant[] = [
  { id: "chatgpt", name: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"], names: ["chatgpt", "openai"] },
  { id: "perplexity", name: "Perplexity", hosts: ["perplexity.ai"], names: ["perplexity"] },
  { id: "gemini", name: "Gemini", hosts: ["gemini.google.com", "bard.google.com"], names: ["gemini", "google gemini", "bard"] },
  { id: "claude", name: "Claude", hosts: ["claude.ai"], names: ["claude"] },
  { id: "copilot", name: "Copilot", hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft"], names: ["copilot", "microsoft copilot"] },
  { id: "deepseek", name: "DeepSeek", hosts: ["chat.deepseek.com"], names: ["deepseek"] },
  { id: "meta-ai", name: "Meta AI", hosts: ["meta.ai"], names: ["meta ai"] },
  { id: "grok", name: "Grok", hosts: ["grok.com"], names: ["grok"] },
  { id: "mistral", name: "Le Chat", hosts: ["chat.mistral.ai"], names: ["le chat", "mistral"] },
  { id: "you", name: "You.com", hosts: ["you.com"], names: [] },
  { id: "phind", name: "Phind", hosts: ["phind.com"], names: ["phind"] },
  { id: "poe", name: "Poe", hosts: ["poe.com"], names: [] },
];

/** Every host on the list, for docs and tests. */
export const AI_REFERRER_HOSTS: readonly string[] = AI_ASSISTANTS.flatMap((a) => a.hosts);

/** The assistants' names, for the copy that says what's counted: "ChatGPT, Perplexity, … or Poe". */
export const AI_ASSISTANT_NAMES = (() => {
  const names = AI_ASSISTANTS.map((a) => a.name);
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
})();

/** A host from a bare host, a URL, or a host with a path or port: lower case, no www. Null when it isn't one. */
function hostOf(value: string): string | null {
  const s = value.trim().toLowerCase();
  if (!s) return null;
  const host = s
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/[/:?#].*$/, "")
    .replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

const underHost = (host: string, known: string) => host === known || host.endsWith(`.${known}`);

/**
 * The assistant a source value names, or null. `value` is whatever a tool reports: a referrer host
 * ("chatgpt.com"), a URL ("https://www.perplexity.ai/search"), a utm_source ("chatgpt.com",
 * "perplexity") or a tool's own label ("ChatGPT").
 */
export function aiAssistantFor(value: string | null | undefined): AiAssistant | null {
  if (!value) return null;
  const host = hostOf(value);
  if (host) return AI_ASSISTANTS.find((a) => a.hosts.some((h) => underHost(host, h))) ?? null;
  const name = value.trim().toLowerCase();
  return AI_ASSISTANTS.find((a) => a.name.toLowerCase() === name || a.names.includes(name)) ?? null;
}

/**
 * One row of a tool's sessions by source. `sources` are the values that say where the sessions came
 * from, most telling first (a referrer, then a utm_source); the first one on the list decides.
 */
export interface SourceRow {
  sources: readonly (string | null | undefined)[];
  sessions: number;
  engagedSessions: number;
}

export interface AiAssistantSessions {
  id: string;
  name: string;
  sessions: number;
  engagedSessions: number;
  /** The source values that were counted for it, most sessions first. */
  seenAs: string[];
}

export interface AiReferralGroup {
  sessions: number;
  engagedSessions: number;
  /** Most sessions first. Only assistants with sessions. */
  assistants: AiAssistantSessions[];
}

/** Groups a tool's sessions by source into its AI assistants, dropping every other source. */
export function groupAiReferrals(rows: readonly SourceRow[]): AiReferralGroup {
  const by = new Map<string, AiAssistantSessions & { seen: Map<string, number> }>();
  for (const row of rows) {
    const sessions = Number(row.sessions) || 0;
    if (sessions <= 0) continue;
    let hit: { assistant: AiAssistant; value: string } | null = null;
    for (const v of row.sources) {
      const assistant = aiAssistantFor(v);
      if (assistant && v) {
        hit = { assistant, value: v.trim().toLowerCase() };
        break;
      }
    }
    if (!hit) continue;
    const { assistant, value } = hit;
    let g = by.get(assistant.id);
    if (!g) by.set(assistant.id, (g = { id: assistant.id, name: assistant.name, sessions: 0, engagedSessions: 0, seenAs: [], seen: new Map() }));
    g.sessions += sessions;
    g.engagedSessions += Math.min(sessions, Math.max(0, Number(row.engagedSessions) || 0));
    g.seen.set(value, (g.seen.get(value) ?? 0) + sessions);
  }
  const assistants = [...by.values()]
    .map(({ seen, ...a }) => ({ ...a, seenAs: [...seen.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([v]) => v) }))
    .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
  return {
    sessions: assistants.reduce((n, a) => n + a.sessions, 0),
    engagedSessions: assistants.reduce((n, a) => n + a.engagedSessions, 0),
    assistants,
  };
}

/**
 * The AI assistant behind a sign-up's first visit, from its referrer host, then its
 * utm_source or ref. Null when it wasn't one.
 */
export function aiAssistantForVisit(visit: { referrerHost?: string | null; source?: string | null }): AiAssistant | null {
  return aiAssistantFor(visit.referrerHost) ?? aiAssistantFor(visit.source);
}
