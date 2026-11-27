import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthCardSkeleton } from "@/components/auth/auth-card-skeleton";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Card, CardBody } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { resetTokenUsable } from "@/lib/auth/reset-links";

export async function generateMetadata({ searchParams }: PageProps<"/reset-password">): Promise<Metadata> {
  return { title: (await searchParams).invite === "1" ? "Choose a password" : "Choose a new password" };
}

/**
 * The emailed link opens this page with the token in the query (resetPageLink, src/lib/auth/reset-links.ts).
 * A link mailed before that goes through /api/auth/reset-password/<token>, which sends the token here,
 * or `error` when it has gone. An invite (src/lib/invites.ts) adds `invite=1`, for a first password.
 * A token that is used up or expired gets the expired message, not a form that would fail.
 * The query is read inside Suspense, so the rest of the route prerenders.
 */
export default function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <ResetPasswordCard searchParams={searchParams} />
    </Suspense>
  );
}

async function ResetPasswordCard({ searchParams }: Pick<PageProps<"/reset-password">, "searchParams">) {
  const { token, error, invite } = await searchParams;
  const first = invite === "1";
  const usable = typeof token === "string" && !error && (await resetTokenUsable(token)) ? token : null;
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium">{first ? "Welcome to SEOpen" : "Choose a new password"}</h1>
        {first && <p className="text-sm text-muted">Choose a password for your account. You&apos;ll sign in with it next.</p>}
        {usable ? (
          <ResetPasswordForm token={usable} first={first} />
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
