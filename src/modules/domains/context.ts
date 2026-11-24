import { isFree } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { getCurrentProject, normalizeDomain, type Project } from "@/lib/projects";
import { wantsRun } from "@/lib/run-request";
import { projectScope, type ProjectScope } from "@/lib/workspace";
import { currentWorkspace } from "@/lib/workspace/current";
import { href, param, resolveMarket } from "@/modules/keywords/market";
import type { Market } from "@/modules/keywords/requests";
import { withinQuote } from "./requests";
import { isHostname } from "./transform";

type SearchParams = Record<string, string | string[] | undefined>;

export interface DomainContext {
  /** Normalized target domain; the project's domain when `?q=` is absent; "" when `?q=` isn't a hostname. */
  q: string;
  /** The rejected `?q=` input, when it isn't a hostname. Pages show it and make no API call. */
  invalid: string | null;
  run: boolean;
  /** The workspace the research is for: it pays for runs and must have paid for cached results. */
  workspaceId: number;
  project: Project | null;
  scope: ProjectScope | null;
  m: Market;
  /** True when the target is the current project's own domain in its own market. */
  isProject: boolean;
  /** Why the workspace can't spend, for the Analyze button. */
  refused: string | null;
  /** On the Free plan, which has no research credits: the page says what Starter adds instead of offering a lookup, and `run` is always off. */
  free: boolean;
}

export async function domainContext(sp: SearchParams): Promise<DomainContext> {
  const [ws, project] = await Promise.all([currentWorkspace(), getCurrentProject()]);
  const raw = param(sp.q);
  const normalized = raw ? normalizeDomain(raw) : (project?.domain ?? "");
  const invalid = raw && !isHostname(normalized) ? raw.trim() : null;
  const q = invalid == null ? normalized : "";
  const m = resolveMarket(param(sp.loc), project);
  const { refusal } = await spendState(ws.id);
  const free = isFree(ws);
  return {
    q,
    invalid,
    // Free never asks to spend, so a run=1 address only reads what's already saved.
    run: !free && (await wantsRun(sp.run)),
    workspaceId: ws.id,
    project,
    scope: project ? projectScope(project) : null,
    m,
    isProject: !!project && q === project.domain && m.locationCode === project.locationCode,
    refused: refusal?.message ?? null,
    free,
  };
}

/** Names a lookup for its price quote. `extra` is whatever else changes what it costs. */
export const lookupOf = (c: DomainContext, extra = "") => `${c.q}${extra}|${c.m.locationCode}`;

/** Takes back `run` when what the click would spend now costs more than the price it showed (`withinQuote`). */
export function holdToQuote(c: DomainContext, sp: SearchParams, pendingUsd: number, extra = ""): DomainContext {
  return { ...c, run: c.run && withinQuote(param(sp.quoted), lookupOf(c, extra), pendingUsd) };
}

/** Sub-navigation for /domains. Hrefs carry q and loc but never run=1, so switching tabs never spends. */
export function domainTabs(q: string, loc: number) {
  const p = { q, loc };
  return [
    { href: href("/domains", p), label: "Overview" },
    { href: href("/domains/keywords", p), label: "Keywords" },
    { href: href("/domains/pages", p), label: "Top pages" },
    { href: href("/domains/competitors", p), label: "Competitors" },
    { href: href("/domains/gap", p), label: "Keyword gap" },
    // Saved per project, so it takes no domain or market.
    { href: "/domains/teardowns", label: "Teardowns" },
  ];
}
