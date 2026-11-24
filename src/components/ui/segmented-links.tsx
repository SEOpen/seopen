import Link from "next/link";
import { cn, isRangeCode } from "@/lib/utils";

/** Segmented, as links, for a choice kept in the URL: a date range, a sort. The view stays linkable, and a server component can draw it. */
export function SegmentedLinks({ label, options, className }: { label: string; options: readonly { href: string; label: string; active: boolean }[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn("inline-flex shrink-0 gap-0.5 overflow-hidden rounded-md bg-surface p-0.5", className)}>
      {options.map((o) => (
        <Link
          key={o.href}
          href={o.href}
          prefetch={false}
          aria-current={o.active ? "true" : undefined}
          className={cn(
            "flex h-6 items-center rounded-sm px-2.5 text-xs whitespace-nowrap transition-colors duration-[120ms] ease-instrument focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
            isRangeCode(o.label) && "font-mono",
            o.active ? "bg-accent-subtle text-accent" : "text-muted hover:text-fg",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
