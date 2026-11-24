import { groupAiReferrals, type AiAssistantSessions, type SourceRow } from "@/lib/ai-referrers";
import type { Project } from "@/lib/projects";
import { PlausibleAccessError, PlausibleNotConnectedError, PlausibleQuotaError } from "@/modules/plausible/types";
import { plausibleApis } from "@/modules/plausible/api";
import { posthogApis } from "@/modules/posthog/api";
import { PosthogAccessError, PosthogNotConnectedError, PosthogQuotaError } from "@/modules/posthog/types";
import { umamiApis } from "@/modules/umami/api";
import { UmamiAccessError, UmamiNotConnectedError, UmamiQuotaError, UmamiUnreachableError } from "@/modules/umami/types";
import { googleApis } from "./apis";
import { GoogleAccessError } from "./auth";
import { GoogleNotConnectedError, GoogleQuotaError } from "./types";
import type { DateRange } from "./windowing";

/**
 * Visits from AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot and the rest of
 * src/lib/ai-referrers.ts), for the Analytics page and MCP's get_analytics. Synced rows only hold
 * organic search, so this asks the project's Analytics source for its sessions by source when it's
 * shown, and stores nothing.
 */

export type AnalyticsSourceKey = "ga4" | "posthog" | "plausible" | "umami";

export const SOURCE_LABEL: Record<AnalyticsSourceKey, string> = { ga4: "GA4", posthog: "PostHog", plausible: "Plausible", umami: "Umami" };

/** The project's Analytics source, in the same order the Analytics page reads it. Null with none. */
export function analyticsSourceOf(project: Pick<Project, "ga4Property" | "posthogProject" | "plausibleSite" | "umamiSite">): { key: AnalyticsSourceKey; id: string } | null {
  if (project.umamiSite) return { key: "umami", id: project.umamiSite };
  if (project.plausibleSite) return { key: "plausible", id: project.plausibleSite };
  if (project.posthogProject) return { key: "posthog", id: project.posthogProject };
  if (project.ga4Property) return { key: "ga4", id: project.ga4Property };
  return null;
}

/** What each source's figure is made of, said wherever it's shown. */
export const AI_COUNTED: Record<AnalyticsSourceKey, string> = {
  ga4: "GA4 sessions whose session source is an AI assistant's site, from its referrer or a utm_source tag such as chatgpt.com",
  posthog: "PostHog sessions whose entry referrer, or else entry utm_source, is an AI assistant",
  plausible: "Plausible visits whose source is an AI assistant, from a utm_source, source or ref tag, or else the referrer",
  umami: "Umami visits whose referrer is an AI assistant's site, in UTC days. Umami's referrer report has no utm_source, so a tagged link that sent no referrer isn't counted",
};

export type AiReferrals =
  | { state: "ok"; source: AnalyticsSourceKey; period: DateRange; sessions: number; engagedSessions: number; assistants: AiAssistantSessions[] }
  | { state: "error"; source: AnalyticsSourceKey; period: DateRange; message: string }
  | { state: "none" };

/** Why the source couldn't be read, in words for the customer. Pure. */
export function referralProblem(source: AnalyticsSourceKey, err: unknown): string {
  const name = SOURCE_LABEL[source];
  if (err instanceof GoogleNotConnectedError || err instanceof PosthogNotConnectedError || err instanceof PlausibleNotConnectedError || err instanceof UmamiNotConnectedError) {
    return `${name} needs reconnecting before SEOpen can read its visits from AI assistants.`;
  }
  if (err instanceof GoogleQuotaError || err instanceof PosthogQuotaError || err instanceof PlausibleQuotaError || err instanceof UmamiQuotaError) {
    return `${name} is limiting requests right now. Try again in a few minutes.`;
  }
  if (err instanceof PlausibleAccessError && err.reason === "plan") return "Plausible says this account doesn't include the Stats API, or its subscription has lapsed.";
  if (err instanceof GoogleAccessError || err instanceof PosthogAccessError || err instanceof PlausibleAccessError || err instanceof UmamiAccessError) {
    return `${name} didn't let SEOpen read this project's visits by source.`;
  }
  if (err instanceof UmamiUnreachableError) return err.message;
  return `${name} didn't answer, so visits from AI assistants can't be shown. Try again in a minute.`;
}

async function sourceRows(workspaceId: number, key: AnalyticsSourceKey, id: string, period: DateRange): Promise<SourceRow[]> {
  switch (key) {
    case "ga4":
      return (await googleApis(workspaceId)).ga4.sourceSessions(id, period.start, period.end);
    case "posthog":
      return posthogApis(workspaceId).sourceSessions(Number(id), period.start, period.end);
    case "plausible":
      return plausibleApis(workspaceId).sourceSessions(id, period.start, period.end);
    case "umami":
      return umamiApis(workspaceId).sourceSessions(id, period.start, period.end);
  }
}

/**
 * The project's sessions from AI assistants over `period`, asked of its Analytics source now.
 * Never throws: a source that can't be read says why.
 */
export async function aiReferrals(project: Pick<Project, "workspaceId" | "ga4Property" | "posthogProject" | "plausibleSite" | "umamiSite">, period: DateRange): Promise<AiReferrals> {
  const source = analyticsSourceOf(project);
  if (!source) return { state: "none" };
  try {
    const group = groupAiReferrals(await sourceRows(project.workspaceId, source.key, source.id, period));
    return { state: "ok", source: source.key, period, ...group };
  } catch (err) {
    console.error(`[ai-referrals] ${source.key}:`, err instanceof Error ? err.name : "unknown");
    return { state: "error", source: source.key, period, message: referralProblem(source.key, err) };
  }
}
