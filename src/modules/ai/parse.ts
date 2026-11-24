/** Parsing llm_responses results. Pure functions, no I/O. */
import type { LlmAnnotation, LlmResponseResult } from "./types";

/**
 * The answer text and its citation annotations from an llm_responses result.
 * Skips `reasoning` items (ChatGPT's reasoning summaries are not part of the answer). A message's
 * sections are fragments split at citation boundaries (Claude), so they join with no separator;
 * separate messages join with a blank line. Model citation markup is removed (`cleanAnswer`).
 */
export function answerFrom(result: LlmResponseResult | null): { text: string; annotations: LlmAnnotation[]; model: string | null } {
  const messages: string[] = [];
  const annotations: LlmAnnotation[] = [];
  for (const item of result?.items ?? []) {
    if (item.type === "reasoning") continue;
    let text = "";
    for (const s of item.sections ?? []) {
      if (s.text) text += s.text;
      if (s.annotations) annotations.push(...s.annotations);
    }
    const clean = cleanAnswer(text);
    if (clean) messages.push(clean);
  }
  return { text: messages.join("\n\n"), annotations, model: result?.model_name ?? null };
}

/** ChatGPT's search tool ids: turn0search3, turn12news1, turn3view0… */
const TURN = String.raw`turn\d+(?:search|news|view|fetch|open|image|file|forecast|finance|sports|product|reddit|video)\d+`;
/** Markup kinds that are pure references and render as nothing. */
const DROP_KINDS = /^(?:cite|filecite|navlist|image_group|video|forecast|schedule|finance|sports|i)$/;

/** The readable part of one private-use ChatGPT block: "entity", "url" and friends keep their label. */
function blockLabel(body: string): string {
  const [kind, ...fields] = body.split("");
  if (DROP_KINDS.test(kind.trim())) return "";
  for (const f of fields) {
    const t = f.trim();
    if (!t || new RegExp(`^(?:${TURN})+$`).test(t)) continue;
    if (t.startsWith("[")) return jsonLabel(t);
    return t;
  }
  return "";
}

/** `["software","Jotwell",0]` → "Jotwell" (the display name is the second string). */
function jsonLabel(raw: string): string {
  try {
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const strings = arr.filter((x): x is string => typeof x === "string");
      return strings[1] ?? strings[0] ?? "";
    }
  } catch {
    // Not JSON: fall through to a regex read.
  }
  const strings = [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return strings[1] ?? strings[0] ?? "";
}

/**
 * Remove citation markup that models leave in their text, so a rendered answer reads cleanly:
 * - ChatGPT's private-use blocks (U+E200 … U+E201) and their leaked plain forms:
 *   `citeturn0search3turn0news1` goes, `entity["software","Jotwell",0]` becomes "Jotwell",
 *   `urlView pricingturn0search4` becomes "View pricing";
 * - `【4:0†source】` source markers;
 * - Perplexity's `[1][3]` and Gemini's `[cite: 1, 2]` reference numbers (markdown links stay);
 * - `<cite …>` style tags (the text inside stays).
 * Markdown is otherwise untouched.
 */
export function cleanAnswer(text: string): string {
  let s = text
    .replace(/([^]*)/g, (_, body: string) => blockLabel(body))
    // Leaked forms without the private-use delimiters.
    .replace(/(?<![A-Za-z])entity(\[[^\]\n]*\])/g, (_, json: string) => jsonLabel(json))
    .replace(new RegExp(String.raw`(?<![A-Za-z])url([^\n]*?)(?:${TURN})+`, "g"), "$1")
    .replace(new RegExp(String.raw`(?<![A-Za-z])(?:cite|filecite|navlist)?(?:${TURN})+`, "g"), "")
    .replace(/(?<![A-Za-z])url(?=[A-Z])/g, "")
    .replace(/【[^】\n]{0,80}】/g, "")
    .replace(/\[cite(?:_start|_end)?(?::[^\]\n]*)?\]/gi, "")
    // [1], [1][2], [1, 2] that aren't a markdown link's label.
    .replace(/[ \t]?(?:\[\d{1,3}(?:\s*,\s*\d{1,3})*\])+(?!\()/g, "")
    .replace(/<\/?(?:cite|source|sup)\b[^>]*>/gi, "")
    .replace(/[-]/g, "");
  // Tidy what the removals leave: empty parentheses, space before punctuation, doubled spaces.
  s = s
    .replace(/[ \t]*\(\s*\)/g, "")
    .replace(/(\S)[ \t]+([.,;:!?])(?=\s|$)/g, "$1$2")
    .replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ");
  return s.trim();
}
