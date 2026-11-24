import { cn } from "@/lib/utils";

/**
 * A share as a bar, with its number beside it in text. `track` makes it a meter, whose full width means
 * 100%; a ranked list has none. `strong` is the measurement, or you; `neutral` is everyone else.
 */
export function Bar({ value, tone = "strong", track = false }: { value: number | null; tone?: "strong" | "neutral"; track?: boolean }) {
  return (
    <div aria-hidden className={cn("h-1.5 w-full overflow-hidden rounded-sm", track && "bg-surface-2")}>
      <div className={cn("h-full rounded-sm", tone === "strong" ? "bg-secondary" : "bg-line-strong")} style={{ width: `${Math.max(0, Math.min(100, (value ?? 0) * 100))}%` }} />
    </div>
  );
}
