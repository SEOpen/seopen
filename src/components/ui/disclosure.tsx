import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * A `<details>` summary with a drawn chevron in place of the browser's triangle, which turns a
 * quarter when open. The `<details>` needs the `group` class for the turn.
 */
export function Summary({ className, children, ...props }: ComponentProps<"summary">) {
  return (
    <summary
      className={cn(
        "flex cursor-pointer list-none items-center gap-1.5 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden",
        className,
      )}
      {...props}
    >
      <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform duration-[120ms] group-open:rotate-90 motion-reduce:transition-none" />
      {children}
    </summary>
  );
}
