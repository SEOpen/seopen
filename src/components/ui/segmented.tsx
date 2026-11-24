"use client";

import { onRadioKey } from "@/lib/radio-keys";
import { cn, isRangeCode } from "@/lib/utils";

/** A small set of exclusive choices: the selected one sits on Raised in the readable blue. */
export function Segmented<T extends string>({ label, options, value, onChange, className }: { label: string; options: readonly T[]; value: T; onChange: (value: T) => void; className?: string }) {
  // One tab stop for the group, as the radio role promises: the selected option, or the first if none is.
  const stop = Math.max(options.indexOf(value), 0);
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex shrink-0 gap-0.5 overflow-hidden rounded-md bg-surface p-0.5", className)}>
      {options.map((o, i) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={o === value}
          tabIndex={i === stop ? 0 : -1}
          onClick={() => onChange(o)}
          onKeyDown={(e) => onRadioKey(e, i, options.length, (next) => onChange(options[next]))}
          className={cn(
            "h-6 rounded-sm px-2.5 text-xs pointer-coarse:h-11 pointer-coarse:px-4 whitespace-nowrap transition-colors duration-[120ms] ease-instrument focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
            isRangeCode(o) && "font-mono",
            o === value ? "bg-accent-subtle text-accent" : "text-muted hover:text-fg",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
