import Link from "next/link";
import { rules } from "@/plan-policy/rules";

const BILLING_PAGE = "the Billing page";

/** A plan refusal as text, with "the Billing page" it names made a link there (gates.ts and spend.ts say it in words). */
export function RefusalText({ text }: { text: string }) {
  const at = text.indexOf(BILLING_PAGE);
  if (at < 0 || !rules.plansHref) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <Link href={rules.plansHref} className="underline">
        {BILLING_PAGE}
      </Link>
      {text.slice(at + BILLING_PAGE.length)}
    </>
  );
}
