import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { SIGNUP_ERRORS } from "@/lib/signup";
import { signupOpen } from "@/lib/signup-open";

export const metadata: Metadata = { title: "Confirm your email" };

/**
 * Where a failed confirmation link lands (Better Auth adds ?error=); a good one signs straight in.
 * With sign-up open, a link for an inbox that already has an account lands here too
 * (`inbox_taken`, `inbox_cooldown`, src/lib/signup.ts), and the address stays unconfirmed.
 */
export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const { error } = await searchParams;
  const refused = signupOpen() && typeof error === "string" ? SIGNUP_ERRORS[error] : undefined;
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium">Confirm your email</h1>
        {refused ? (
          <Callout tone="bad" title={refused} />
        ) : error ? (
          <Callout tone="bad" title="That link has expired or was already used.">
            Sign in and choose &ldquo;Send the link again&rdquo; for a fresh one.
          </Callout>
        ) : (
          <p className="text-sm text-muted">We sent a confirmation link to your inbox. It expires in 24 hours.</p>
        )}
        <Link href="/sign-in" className="text-sm underline">
          Go to sign in
        </Link>
      </CardBody>
    </Card>
  );
}
