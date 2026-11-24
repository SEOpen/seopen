import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { ModuleTabs } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Severity } from "../taxonomy";

const SEVERITY_TONE = { error: "bad", warning: "warn", notice: "neutral" } as const;
const SEVERITY_WORD = { error: "Error", warning: "Warning", notice: "Notice" } as const;

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_WORD[severity]}</Badge>;
}

const AUDIT_TABS = [
  { href: "/audit", label: "Overview" },
  { href: "/audit/issues", label: "Issues" },
  { href: "/audit/pages", label: "Pages" },
  { href: "/audit/compare", label: "Compare crawls" },
];

export function AuditTabs() {
  return <ModuleTabs tabs={AUDIT_TABS} />;
}

export interface StatusCounts {
  ok: number;
  withIssues: number;
  redirect: number;
  clientError: number;
  serverError: number;
  noResponse: number;
}

/** A thin split bar of crawled URLs by outcome. The legend carries the words, and a row with none doesn't show. */
export function StatusBar({ counts }: { counts: StatusCounts }) {
  const parts = [
    { key: "ok", label: "Healthy", n: counts.ok, cls: "bg-secondary" },
    { key: "withIssues", label: "Errors or warnings", n: counts.withIssues, cls: "bg-warn-mark" },
    { key: "redirect", label: "Redirects", n: counts.redirect, cls: "bg-line-strong" },
    { key: "clientError", label: "Not found or refused (4xx)", n: counts.clientError, cls: "bg-bad" },
    { key: "serverError", label: "Server errors (5xx)", n: counts.serverError, cls: "bg-chart-4" },
    { key: "noResponse", label: "No response", n: counts.noResponse, cls: "bg-chart-2" },
  ].filter((p) => p.n > 0);
  if (!parts.length) return <p className="text-sm text-muted">No URLs in this crawl.</p>;
  return (
    <div>
      <div role="img" aria-label={`Crawled URLs: ${parts.map((p) => `${formatNumber(p.n)} ${p.label.toLowerCase()}`).join(", ")}`} className="flex h-1.5 gap-0.5">
        {parts.map((p) => (
          <div key={p.key} className={cn("min-w-0.5", p.cls)} style={{ flex: `${p.n} 1 0` }} />
        ))}
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 text-[13px] text-secondary">
        {parts.map((p) => (
          <li key={p.key} className="flex items-baseline gap-2">
            <span aria-hidden className={cn("size-2 shrink-0 self-center rounded-full", p.cls)} />
            <span className="min-w-0 flex-1">{p.label}</span>
            <span className="data text-fg">{formatNumber(p.n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The next step from a crawl's issues: the Fixes page, where they're listed with what to change and a
 * prompt for a coding agent. `mock`: the site's mockup draws it as a plain button, with no link into the app.
 */
export function FixesNext({ mock = false }: { mock?: boolean }) {
  const label = "Fix these with your agent";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      {mock ? (
        <Button variant="secondary" size="sm">
          {label}
        </Button>
      ) : (
        <ButtonLink href="/fixes" variant="secondary" size="sm">
          {label}
        </ButtonLink>
      )}
      <span className="text-xs text-muted">Fixes says what to change on each page, with a prompt for your coding agent.</span>
    </div>
  );
}

/** Lets a long row of filters scroll inside itself on a narrow screen rather than widen the page. */
export function FilterScroll({ children }: { children: ReactNode }) {
  return <div className="max-w-full overflow-x-auto [scrollbar-width:none]">{children}</div>;
}

/** Builds a query string from defined values. */
export function qs(params: Record<string, string | number | null | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
}

export function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
