import { cn } from "@/lib/utils";

// A number with what's stuck to it: "−12", "$1,204", "12.3%", "18.3K", "3h". The rest of the text is words.
const NUMBER = /[+−-]?[$€£]?\d+(?:[.,]\d+)*[%\p{L}]*/gu;

/** Text cut into its numbers and its words, in order, so nothing is lost. */
export function digitRuns(text: string): { text: string; digits: boolean }[] {
  const runs: { text: string; digits: boolean }[] = [];
  let from = 0;
  for (const match of text.matchAll(NUMBER)) {
    if (match.index > from) runs.push({ text: text.slice(from, match.index), digits: false });
    runs.push({ text: match[0], digits: true });
    from = match.index + match[0].length;
  }
  if (from < text.length) runs.push({ text: text.slice(from), digits: false });
  return runs;
}

/**
 * Mixed text with the data size on its numbers only: "33 keywords · 12,550 searches/mo". Words keep their
 * own size and normal tracking. `digitClassName` is for a parent that already sets the numbers' type, like
 * a big figure.
 */
export function Digits({ text, digitClassName = "digits" }: { text: string; digitClassName?: string }) {
  return (
    <>
      {digitRuns(text).map((run, i) =>
        run.digits ? (
          <span key={i} className={digitClassName}>
            {run.text}
          </span>
        ) : (
          <span key={i} className="font-sans">
            {run.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * A change: a glyph for which way the number moved, its size, and a colour for better or worse.
 * Colour says better or worse, so screen readers get the word. `text` is what describeChange gives
 * ("+12.3%", "−2.3", "2.4 better"); the glyph replaces the sign. All of it is Geist Mono, words too.
 */
export function Delta({ text, tone, up, className }: { text: string; tone: "good" | "bad" | "muted"; up?: boolean | null; className?: string }) {
  const signed = /^[+−-]/.test(text);
  const direction = up ?? (signed ? text.startsWith("+") : null);
  return (
    <span className={cn("font-mono text-xs tracking-normal whitespace-nowrap", tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-muted", className)}>
      {direction != null && (
        <svg aria-hidden viewBox="0 0 8 8" className={cn("mr-1 inline-block size-[0.6em] align-[0.05em] fill-current", !direction && "rotate-180")}>
          <path d="M4 1 7.5 7h-7z" />
        </svg>
      )}
      {direction != null && <span className="sr-only">{direction ? "up " : "down "}</span>}
      {signed ? text.slice(1) : text}
      {tone !== "muted" && <span className="sr-only"> ({tone === "good" ? "better" : "worse"})</span>}
    </span>
  );
}
