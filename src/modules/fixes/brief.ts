import type { FixStatus } from "./queries";

/**
 * The list's tabs, by what each status means: nobody has acted,
 * someone changed it and SEOpen is checking, or it's settled, measured at 28 days or no longer found.
 */
export const FIX_TABS: { key: string; label: string; statuses: FixStatus[] }[] = [
  { key: "open", label: "To fix", statuses: ["open"] },
  { key: "checking", label: "Being checked", statuses: ["applied", "live"] },
  { key: "done", label: "Done", statuses: ["measured", "resolved"] },
  { key: "dismissed", label: "Dismissed", statuses: ["dismissed"] },
];

/** The button on a fix to do. It records a change, which then gets checked: it isn't Done yet. */
export const APPLY_LABEL = "Mark as changed";

/** The figures above the list, each the same fixes as the tab it opens. */
export function fixesFigures(counts: Record<FixStatus, number>, agentCanFix: number): { label: string; value: string; href: string; caption?: string }[] {
  const tab = (key: string) => FIX_TABS.find((t) => t.key === key)!;
  const value = (key: string) => tab(key).statuses.reduce((n, s) => n + counts[s], 0).toLocaleString("en-US");
  return [
    { label: tab("open").label, value: value("open"), href: "/fixes", caption: agentCanFix ? `${agentCanFix.toLocaleString("en-US")} in the code` : undefined },
    { label: tab("checking").label, value: value("checking"), href: "/fixes?status=checking", caption: "Changed, and waiting on the live page or its numbers" },
    { label: tab("done").label, value: value("done"), href: "/fixes?status=done", caption: "Measured at 28 days, or no longer found" },
  ];
}

/** The Fixes page's opening line. Pure, so "nothing to do" is a real answer and it's cheap to test. */
export function fixesSentence(domain: string, counts: Record<FixStatus, number>, agentCanFix: number, latestLine: string | null): string {
  if (latestLine) return latestLine;
  const open = counts.open;
  const moving = counts.applied + counts.live;
  if (open) {
    const code = agentCanFix === open ? (open === 1 ? " It can be changed in the code." : " All of them can be changed in the code.") : agentCanFix ? ` ${agentCanFix.toLocaleString("en-US")} can be changed in the code.` : "";
    const also = moving ? ` ${moving.toLocaleString("en-US")} ${moving === 1 ? "change is" : "changes are"} being checked.` : "";
    return `${open.toLocaleString("en-US")} ${open === 1 ? "thing is" : "things are"} worth fixing on ${domain}.${code}${also}`;
  }
  if (moving) return `Nothing new to fix on ${domain}, and ${moving.toLocaleString("en-US")} ${moving === 1 ? "change is" : "changes are"} being checked.`;
  if (counts.measured || counts.resolved) return `Nothing to fix on ${domain} right now.`;
  return `Nothing to fix on ${domain} yet. Fixes come from a site audit and from Search Console.`;
}
