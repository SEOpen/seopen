import type { TeardownFinding, TeardownMove } from "@/db/schema";
import { rules } from "@/plan-policy/rules";

/** What a move's size means in words. "Project" in the tool's input means a larger build, not an SEOpen project. */
export const MOVE_SIZE_LABEL: Record<TeardownMove["size"], string> = { page: "One page", template: "A template", project: "A larger build" };

/**
 * Splits a summary into its first sentence and the rest, so the page can lead with the verdict.
 * A sentence ends at . ! or ? followed by a space or the end, so a domain such as example.com stays whole.
 */
export function splitLead(summary: string): { lead: string; rest: string } {
  const text = summary.trim();
  const firstLine = text.split("\n")[0];
  const sentence = firstLine.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? firstLine;
  return { lead: sentence.trim(), rest: text.slice(sentence.length).trim() };
}

/** The lead sentence, cut to `max` characters for a list row. */
export function leadSentence(summary: string, max = 180): string {
  const { lead } = splitLead(summary);
  return lead.length > max ? `${lead.slice(0, max - 1).trimEnd()}…` : lead;
}

export interface TeardownForExport {
  domain: string;
  summary: string;
  findings: TeardownFinding[];
  moves: TeardownMove[];
  creditsSpent: number;
  savedBy: string | null;
}

/** The teardown as a Markdown file: summary, moves, then findings, the same order as the page. */
export function teardownMarkdown(t: TeardownForExport, meta: { projectName: string; market: string; savedOn: string }): string {
  const credits = t.creditsSpent ? `${rules.creditsText(t.creditsSpent)} spent` : `${rules.hasPlans ? `no ${rules.researchNoun}` : "nothing"} spent`;
  const lines = [
    `# Teardown: ${t.domain}`,
    "",
    `For ${meta.projectName}, measured in ${meta.market}. Saved ${meta.savedOn}${t.savedBy ? ` by ${t.savedBy}` : ""}, ${credits}. Traffic figures are provider estimates.`,
    "",
    t.summary,
    "",
    "## Moves for your site",
    "",
  ];
  t.moves.forEach((m, i) => {
    lines.push(`### ${i + 1}. ${m.title}`, "", `Size: ${MOVE_SIZE_LABEL[m.size] ?? m.size}`, "", m.why, "", `First step: ${m.firstStep}`, "");
  });
  if (t.findings.length) {
    lines.push(`## What ${t.domain} does`, "");
    for (const f of t.findings) lines.push(`### ${f.title}`, "", f.body, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
