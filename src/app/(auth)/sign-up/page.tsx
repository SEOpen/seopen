import type { Metadata } from "next";
import Link from "next/link";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { Card, CardBody } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { googleLoginConfigured } from "@/lib/auth";
import { firstVisitFromParams } from "@/lib/first-visit";
import { rules } from "@/plan-policy/rules";
import { siteHref, siteLinks, waitlistHref } from "@/lib/hosts";
import { SIGNUP_ERRORS } from "@/lib/signup";
import { signupOpen } from "@/lib/signup-open";
import { turnstileSiteKey } from "@/lib/turnstile";

export const metadata: Metadata = { title: "Sign up" };

/**
 * Closed (SEOPEN_SIGNUP_OPEN unset), the beta's waitlist note: accounts are made by an invite from
 * /admin/waitlist (src/lib/invites.ts). A self-hosted copy has no waitlist, so it only says sign-up is
 * closed. It reads no request data, so it stays a static page.
 * Open, the real sign-up (src/lib/signup.ts).
 */
export default async function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  if (!signupOpen()) return <BetaNote />;
  const params = await searchParams;
  const { error } = params;
  // Where the visit to the site came from, when its sign-up link carried it (src/lib/first-visit.ts).
  const firstVisit = firstVisitFromParams(params);
  const refusal = typeof error === "string" ? (SIGNUP_ERRORS[error] ?? "Google sign-up didn't work. Try your email and a password.") : null;

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium">Create your SEOpen account</h1>
        {rules.newAccountLine("sign-up") && <p className="text-sm text-muted">{rules.newAccountLine("sign-up")}</p>}
        {refusal && <Callout tone="bad" title={refusal} />}
        <SignUpForm google={googleLoginConfigured} firstVisit={firstVisit} turnstileSiteKey={turnstileSiteKey()} />
        {siteLinks() && (
          <p className="text-xs text-muted">
            Creating an account means you accept the{" "}
            <a className="underline" href={siteHref("/terms")}>
              Terms
            </a>{" "}
            and the{" "}
            <a className="underline" href={siteHref("/privacy")}>
              Privacy policy
            </a>
            .
          </p>
        )}
        <p className="border-t border-line pt-4 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link className="underline" href="/sign-in">
            Sign in
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}

function BetaNote() {
  const waitlist = waitlistHref();
  if (!waitlist) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <h1 className="text-base font-medium">Sign-up is closed</h1>
          <p className="text-sm text-muted">This copy of SEOpen isn&apos;t taking new accounts.</p>
          <p className="text-sm text-muted">Got an invite? Use the button in the email to choose your password.</p>
          <Link href="/sign-in" className="text-sm underline">
            Already have an account? Sign in
          </Link>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <h1 className="text-base font-medium">SEOpen is in private beta</h1>
        <p className="text-sm text-muted">
          Invites go out in batches.{" "}
          <a className="underline" href={waitlist}>
            Join the waitlist
          </a>{" "}
          {`and we'll email you when yours is ready.${rules.newAccountLine("waitlist") ? ` ${rules.newAccountLine("waitlist")}` : ""}`}
        </p>
        <p className="text-sm text-muted">Got an invite? Use the button in the email to choose your password.</p>
        <Link href="/sign-in" className="text-sm underline">
          Already have an account? Sign in
        </Link>
      </CardBody>
    </Card>
  );
}
