import type { ReactNode } from "react";
import { FigureStrip } from "./figure";

/**
 * The top of every module page: one plain sentence saying what changed and against what, then three or
 * four figures. The sentence comes from a pure function over stored data, so it costs nothing to load,
 * and "nothing moved" is a real, calm answer.
 */
export function Briefing({ sentence, children, className }: { sentence: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {/* A sentence can name a project or quote a domain with nowhere to break, which on a phone would widen the page. */}
      <p className="max-w-[51ch] text-[19px] leading-[27px] font-normal tracking-[-0.01em] md:text-[22px] md:leading-[30px] [overflow-wrap:anywhere] text-pretty text-fg">{sentence}</p>
      {children && <FigureStrip className="mt-4">{children}</FigureStrip>}
    </div>
  );
}
