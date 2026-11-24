import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A focused field gets the accent edge and a dim halo. The site's larger fields use this too. */
export const fieldFocus =
  "outline-none transition-[border-color] duration-[120ms] ease-instrument focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-subtle)]";

// 16px under 640px: iOS Safari zooms the page into any field with smaller text.
const field = `h-[38px] rounded-md border border-line-strong bg-surface px-3 text-base text-fg sm:text-sm placeholder:text-muted ${fieldFocus} aria-invalid:border-bad disabled:text-disabled`;

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(field, "w-full", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(field, "h-auto w-full py-2", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        field,
        "appearance-none bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2010%2010%27%3E%3Cpath%20d=%27M1%203h8L5%208z%27%20fill=%27%2385858f%27/%3E%3C/svg%3E)] bg-[length:9px_9px] bg-[position:right_12px_center] bg-no-repeat pr-8",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("flex flex-col gap-2 text-sm font-medium text-fg", className)} {...props} />;
}
