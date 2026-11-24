import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A titled stretch of a page, as tall as its content, with no box. Forms and settings use Card; tables and charts sit here. */
export function Section({ title, description, actions, className, headingAs: Heading = "h2", children }: { headingAs?: "h2" | "div";  title: string; description?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("mt-8", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <Heading id={id} className="text-[15px] font-medium">
            {title}
          </Heading>
          {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
