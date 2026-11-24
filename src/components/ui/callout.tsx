import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones = {
  info: { dot: "bg-secondary", title: "text-fg" },
  warn: { dot: "bg-warn-mark", title: "text-warn" },
  bad: { dot: "bg-bad", title: "text-bad" },
} as const;

/** A panel with a status dot. Never a coloured edge. `role="alert"` for an error that appears after the user acts, so screen readers announce it. */
export function Callout({ tone = "info", title, children, role }: { tone?: keyof typeof tones; title?: string; children?: ReactNode; role?: "alert" | "status" }) {
  const t = tones[tone];
  return (
    <div role={role} className="panel grid grid-cols-[8px_minmax(0,1fr)] gap-3 px-4 py-3 text-sm">
      <span aria-hidden className={cn("mt-1.5 size-2 rounded-full", t.dot)} />
      {/* Messages can quote a URL with nowhere to break, which on a phone would widen the page. */}
      <div className="[overflow-wrap:anywhere]">
        {title &&<div className={cn("font-medium", t.title)}>{title}</div>}
        {children && <div className={cn(title && "mt-1", "text-secondary")}>{children}</div>}
      </div>
    </div>
  );
}
