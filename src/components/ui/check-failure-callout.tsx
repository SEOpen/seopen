import Link from "next/link";
import { Callout } from "./callout";

const LINK = "mt-2 block text-xs font-medium text-accent hover:underline";

/**
 * The newest check failed: what, why, what the numbers below are from, and the way forward. Shared so
 * every module says it in the same order. Not an alert: it's there on page load, not after the customer acted.
 */
export function CheckFailureCallout({
  title,
  reason,
  from,
  again,
  link,
  stuck = false,
}: {
  title: string;
  /** Why, in the customer's words. */
  reason: string;
  /** What the last good results are from, when there are any: "Results below are from Nov 5." */
  from?: string | null;
  /** When the check's own button can work: "Check now runs it again." */
  again?: string | null;
  /** When the way forward is somewhere else. */
  link?: { label: string; href: string } | null;
  /** It didn't start, which a backlog can do too, so it's a warning and not a failure. */
  stuck?: boolean;
}) {
  const said = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return (
    <div className="mb-4">
      <Callout tone={stuck ? "warn" : "bad"} title={title}>
        {[said, from, again].filter(Boolean).join(" ")}
        {/* A plain anchor for a place on this page: Next's Link ignores a click to the hash already in the URL. */}
        {link &&
          (link.href.startsWith("#") ? (
            <a href={link.href} className={LINK}>
              {link.label}
            </a>
          ) : (
            <Link href={link.href} prefetch={false} className={LINK}>
              {link.label}
            </Link>
          ))}
      </Callout>
    </div>
  );
}
