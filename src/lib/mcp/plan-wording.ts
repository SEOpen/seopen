/**
 * Plan refusals as an agent hears them. The app's wording offers a way to buy ("Upgrade now", "Choose
 * a plan on the Billing page"), which the app pages turn into a button or a link. A directory listing
 * may not promote a plan, so MCP keeps why something was refused and drops the offer.
 */

const OFFER = /\b[Uu]pgrade now\b|\b[Cc]hoose a plan\b|\bthe Billing page\b|^Upgrade(?: to |$)/;
/** What's left of an offer once its own clause is gone, such as "Paid checks start then." */
const FOLLOWS_OFFER = /\bstart then\b|\bfirst payment\b/i;
const FALLBACK = "This isn't part of this workspace's plan.";

const sentence = (text: string) => {
  const trimmed = text.trim().replace(/[.;,]+$/, "");
  return trimmed ? `${trimmed[0].toUpperCase()}${trimmed.slice(1)}.` : "";
};

/** One sentence without its offer: the whole sentence, the clause that makes it, or nothing. */
function withoutOffer(text: string): string {
  // "Upgrade, or archive another project, to edit it": the other way out is worth keeping.
  const other = /^Upgrade, or (.+?), (to .+)$/.exec(text);
  if (other) return sentence(`${other[1]} ${other[2]}`);
  const clauses = text.split(/;\s+|,\s+or\s+/);
  if (!clauses.some((c) => OFFER.test(c))) return text;
  return sentence(clauses.filter((c) => !OFFER.test(c) && !FOLLOWS_OFFER.test(c)).join("; "));
}

/** A refusal with nothing to buy in it. Text without an offer comes back as it was. */
export function plainRefusal(message: string): string {
  if (!message.split(/(?<=[.!?])\s+|;\s+|,\s+or\s+/).some((part) => OFFER.test(part))) return message;
  const kept = message
    .split(/(?<=[.!?])\s+/)
    .map(withoutOffer)
    .filter((s) => s && !FOLLOWS_OFFER.test(s));
  return kept.join(" ") || FALLBACK;
}
