import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Card, CardBody } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";

export async function generateMetadata({ searchParams }: PageProps<"/reset-password">): Promise<Metadata> {
  return { title: (await searchParams).invite === "1" ? "Choose a password" : "Choose a new password" };
}

/**
 * The emailed link goes through /api/auth/reset-password/<token>, which sends the token here.
 * A beta invite (src/lib/invites.ts) uses the same link with `invite=1`, for a first password.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token, error, invite } = await searchParams;
  const first = invite === "1";
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium">{first ? "Welcome to SEOpen" : "Choose a new password"}</h1>
        {first && <p className="text-sm text-muted">Choose a password for your account. You&apos;ll sign in with it next.</p>}
        {typeof token === "string" && !error ? (
          <ResetPasswordForm token={token} first={first} />
        ) : (
          <Callout tone="bad" title="That link has expired or was already used.">
            <Link className="underline" href="/forgot-password">
              Get a new link
            </Link>
            {first && " with the email your invite went to."}
          </Callout>
        )}
      </CardBody>
    </Card>
  );
}
