import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Green is for a number that moved the right way and blue for "act here". A chip is neither, so `accent`
// and `good` are a state: neutral, with a dot that sets them apart from a plain chip. `warn` is neutral
// text with an amber dot too, since yellow text on a Raised tint reads muddy in light.
const tones = {
  neutral: { text: "text-secondary", dot: "" },
  accent: { text: "text-fg", dot: "bg-fg" },
  good: { text: "text-fg", dot: "bg-secondary" },
  warn: { text: "text-fg", dot: "bg-warn-mark" },
  bad: { text: "text-bad", dot: "bg-bad" },
} as const;

/**
 * A chip on Raised. A dot carries the tone beside the text, so the colour is never alone. Its words
 * are Outfit even inside a `data` cell, which would otherwise hand them Geist Mono.
 */
export function Badge({ tone = "neutral", className, children, ...props }: ComponentProps<"span"> & { tone?: keyof typeof tones }) {
  const t = tones[tone];
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-sm bg-surface-2 px-[7px] font-sans text-xs leading-none font-normal whitespace-nowrap", t.text, className)} {...props}>
      {t.dot && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />}
      {children}
    </span>
  );
}
