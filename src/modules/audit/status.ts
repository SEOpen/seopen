/**
 * How a crawled URL answered, by its HTTP status. Overview's Crawled URLs bar, the Pages tab's counts and
 * its Status filter all sort pages with this, so a page lands in the same class on each.
 *
 * DataForSEO's crawler gives a status of 0 when it got no answer at all: a timeout, a DNS failure or a
 * refused connection. Those are the URLs the "unreachable" issue lists. A page with no status stored is
 * read the same way. Neither is a server error: no server answered.
 */
export const STATUS_CLASSES = [
  { key: "2xx", label: "OK (2xx)", test: (s: number) => s >= 200 && s < 300 },
  { key: "3xx", label: "Redirects (3xx)", test: (s: number) => s >= 300 && s < 400 },
  { key: "4xx", label: "Client errors (4xx)", test: (s: number) => s >= 400 && s < 500 },
  { key: "5xx", label: "Server errors (5xx)", test: (s: number) => s >= 500 },
  { key: "no-response", label: "No response", test: (s: number) => s === 0 },
] as const;

export type StatusClass = (typeof STATUS_CLASSES)[number]["key"];

/** The class a page's status puts it in, or null for one none covers (a 1xx). */
export function statusClass(statusCode: number | null): StatusClass | null {
  const s = statusCode ?? 0;
  return STATUS_CLASSES.find((c) => c.test(s))?.key ?? null;
}
