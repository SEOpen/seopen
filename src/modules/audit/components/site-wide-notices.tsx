import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Section } from "@/components/ui/section";
import { formatNumber } from "@/lib/format";
import { SITE_WIDE_NOTE } from "../site-wide";

/** Notices on nearly every page (`isSiteWide`), under their own heading and folded, so the issues above them stay in view. */
export function SiteWideNotices({ count, className, children }: { count: number; className?: string; children: ReactNode }) {
  return (
    <Section title="Site-wide notices" description={SITE_WIDE_NOTE} className={className}>
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-xs font-medium text-accent hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" strokeWidth={1.5} />
          <span className="group-open:hidden">
            Show {formatNumber(count)} notice{count === 1 ? "" : "s"}
          </span>
          <span className="hidden group-open:inline">Hide them</span>
        </summary>
        <div className="mt-1">{children}</div>
      </details>
    </Section>
  );
}
