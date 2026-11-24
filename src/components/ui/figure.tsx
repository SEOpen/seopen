import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { projectIdFromPath } from "@/lib/project-cookie";
import { cn } from "@/lib/utils";
import { Delta, Digits } from "./delta";
import { PositionGauge } from "./gauge";
import type { ChangeDelta } from "./what-changed";

const focus = "focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Opening /projects/<id> switches the project cookie, so a prefetch must never reach it. */
const prefetchFor = (href: string) => (projectIdFromPath(href) ? false : undefined);

function FigureLabel({ href, children }: { href?: string; children: ReactNode }) {
  return href ? (
    <Link href={href} prefetch={prefetchFor(href)} className={cn("caps-label w-fit text-muted underline-offset-4 hover:text-fg hover:underline", focus)}>
      {children}
    </Link>
  ) : (
    <div className="caps-label text-muted">{children}</div>
  );
}

/**
 * The one way the app shows a number: label, figure, change, then what it covers. The figure is always
 * in the text colour; only the change carries better or worse. `position` adds the 1–20 gauge, the one
 * reading a gauge earns. `small` is for a strip inside a card.
 */
export function Figure({
  label,
  value,
  delta,
  caption,
  href,
  position,
  small = false,
  children,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  delta?: ChangeDelta | null;
  /** What it covers and what it compares against: "28 days to Oct 30, vs the 28 before". */
  caption?: ReactNode;
  href?: string;
  position?: { value: number; previous?: number | null };
  small?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col", className)}>
      <FigureLabel href={href}>{label}</FigureLabel>
      {/* The change always takes its own line, so values in a strip share a baseline whatever fits beside them. */}
      <p className="mt-2 flex flex-col items-start gap-y-1">
        <span className={cn("figure whitespace-nowrap", small && "text-[22px]!")}>{typeof value === "string" ? <Digits text={value} digitClassName="" /> : value}</span>
        {delta && <Delta {...delta} />}
      </p>
      {position && <PositionGauge position={position.value} previous={position.previous} className="mt-2.5" />}
      {caption && <p className="mt-1.5 text-xs text-muted">{caption}</p>}
      {children}
    </div>
  );
}

/** A number's place when there's no number: why, and one next step. */
export function EmptyFigure({ label, text, tone, action, href, className }: { label: ReactNode; text: ReactNode; tone?: "bad"; action?: { label: string; href: string }; href?: string; className?: string }) {
  return (
    <div data-empty={tone === "bad" ? "bad" : "quiet"} className={cn("flex min-w-0 flex-col items-start", className)}>
      <FigureLabel href={href}>{label}</FigureLabel>
      <p className={cn("mt-2 text-[13px]", tone === "bad" ? "text-bad" : "text-secondary")}>{text}</p>
      {action && (
        <Link href={action.href} prefetch={prefetchFor(action.href)} className={cn("mt-1 inline-flex min-h-6 items-center gap-1 text-xs font-medium text-accent underline-offset-3 hover:underline", focus)}>
          {action.label}
          <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
        </Link>
      )}
    </div>
  );
}

/** A figure as data, for a page whose numbers come from a pure function. */
export type FigureData = {
  id: string;
  label: string;
  href?: string;
  caption?: string;
} & ({ state: "value"; value: string; delta: ChangeDelta | null; position?: { value: number; previous?: number | null } } | { state: "empty"; text: string; tone?: "bad"; action?: { label: string; href: string } });

export function FigureView({ data: f, small }: { data: FigureData; small?: boolean }) {
  return f.state === "value" ? (
    <Figure label={f.label} href={f.href} value={f.value} delta={f.delta} caption={f.caption} position={f.position} small={small} />
  ) : (
    <EmptyFigure label={f.label} href={f.href} text={f.text} tone={f.tone} action={f.action} />
  );
}

/**
 * Figures in a row. `tiles` (the default) stands each in a filled tile, wrapping to what the column holds.
 * `ruled` is for a panel that is already a surface: one row of cells split by hairlines, no tiles, columns
 * set by the nearest container.
 */
export function FigureStrip({ children, label = "Key numbers", variant = "tiles", className }: { children: ReactNode; label?: string; variant?: "tiles" | "ruled"; className?: string }) {
  return (
    <section aria-label={label} className={cn(variant === "ruled" ? "figure-row" : "figure-strip", className)}>
      {children}
    </section>
  );
}
