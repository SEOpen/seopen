/**
 * Searches that look like another tool's checks rather than a person. Search Console counts them like
 * any other, so on a small site they can outnumber real searches. Four shapes:
 *
 * - A number of four or more digits, a colon, a space, then the search: "5196: daily keyword rank
 *   tracking". Rank trackers number the searches they send. Shorter numbers are left alone, because
 *   people type them ("404: page not found meaning"), except three digits in front of a search about
 *   ranking: "327: google online rank tracker".
 * - A pasted spreadsheet row: at least three commas, with two fields of only a number that can't be
 *   a thousands group, such as "vacuform,7,70,i,…,6,0.44,0.85". "1,000,000" stays in.
 * - The search, a comma, then a town and a US state code with no comma between them: "website page
 *   optimization, derry nh", a rank tracker's keyword and location. People put the comma
 *   between town and state ("seo cost in salem, nh"), and those searches stay in.
 * - An AI prompt tracker's prompt, which ends with where it pretends to be: "web design company
 *   salem nh. my location is salem, new hampshire, united states, usa."
 *
 * This is the one rule. Rows that match are flagged `likely_bot` (MCP) or "Likely a rank checker"
 * (the app) and kept in the lists, and left out of totals at read time (`gscTotals`, `gscSeries`, and
 * a fix's before and after in `src/modules/fixes/measure.ts`):
 * the stored daily totals still include them, so nothing needs syncing again. The pattern is plain
 * enough to mean the same in JavaScript, Postgres (`~`) and Search Console's RE2 filters, and Search
 * Console's queries are lowercase.
 */
const US_STATES = "al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc";

/** A spreadsheet field of only a number, but not three digits alone, which reads as a thousands group. */
const CSV_NUMBER = "([0-9]{1,2}|[0-9]{4,}|[0-9]*\\.[0-9]+)";

export const LIKELY_BOT_PATTERN = [
  "^[0-9]{4,}: \\S",
  "^[0-9]{3}: \\S.*rank",
  `,${CSV_NUMBER},(.*,)?${CSV_NUMBER},`,
  `^[^,]+, [a-z][a-z.' -]* (${US_STATES})$`,
  "\\. my location is ",
].join("|");

const LIKELY_BOT = new RegExp(LIKELY_BOT_PATTERN);

export function isLikelyBotQuery(query: string): boolean {
  return LIKELY_BOT.test(query);
}

/** What the app's query tables say beside such a search. */
export const LIKELY_BOT_LABEL = "Likely a rank checker";

/** The note for a query table's row, or undefined for a real search. */
export const likelyBotNote = (query: string) => (isLikelyBotQuery(query) ? LIKELY_BOT_LABEL : undefined);

/** How the MCP describes the rule, in one parenthesis. */
export const LIKELY_BOT_RULE =
  'a number of four or more digits, a colon and a space before the search, such as "5196: daily keyword rank tracking", or three digits before a search with "rank" in it, such as "327: google online rank tracker"; a pasted spreadsheet row with two number-only fields between commas, such as "vacuform,7,70,i,6,0.44"; the search, a comma, then a town and state with no comma between, such as "website page optimization, derry nh"; or a prompt ending "my location is …"';
