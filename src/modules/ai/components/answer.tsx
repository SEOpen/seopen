import { cn } from "@/lib/utils";
import { findSpans, segments, type Brand } from "../detect";
import { cleanAnswer } from "../parse";

/** Markdown → readable plain text: model citation markup goes, links keep their label, emphasis markers go. */
export function plainText(markdown: string): string {
  return cleanAnswer(markdown)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An AI answer with your brand and competitors highlighted. Being you isn't good or bad, so neither mark wears a status colour. */
export function HighlightedAnswer({ text, brands }: { text: string; brands: Brand[] }) {
  const plain = plainText(text);
  const segs = segments(plain, findSpans(plain, brands));
  return (
    <div className="max-w-[76ch] text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
      {segs.map((s, i) =>
        s.span ? (
          <mark key={i} title={s.span.domain} className={cn("rounded-sm px-0.5 text-fg", s.span.own ? "bg-accent-subtle font-medium" : "bg-surface-2")}>
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </div>
  );
}

export function Legend() {
  return (
    <span className="inline-flex items-center gap-3 text-xs text-muted">
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="size-2.5 rounded-sm bg-accent-subtle" /> you
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="size-2.5 rounded-sm bg-surface-2" /> competitor
      </span>
    </span>
  );
}
