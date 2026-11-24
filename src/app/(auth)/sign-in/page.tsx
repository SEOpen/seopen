import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { Card, CardBody } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { googleLoginConfigured } from "@/lib/auth";
import { safeCallback } from "@/lib/auth/redirect";
import { signupPage } from "@/public-signup/page";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  signup_disabled: "That Google account isn't linked to a SEOpen account. Sign in with your email and password.",
  account_not_linked: "That Google account's email isn't verified, so it can't be linked. Sign in with your email and password.",
};

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const sp = await searchParams;
  const next = safeCallback(sp.next);
  const errors: Record<string, string> = { ...ERRORS, ...signupPage.signInErrors() };
  const error = typeof sp.error === "string" ? (errors[sp.error] ?? "Google sign-in didn't work. Try your email and password.") : null;
  // Sent here by SEOpen's OAuth server (src/lib/auth/oauth.ts): signing in carries on to the consent page.
  const connecting = typeof sp.sig === "string" && typeof sp.client_id === "string";

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium">Sign in to SEOpen</h1>
        {connecting && <p className="text-sm text-secondary">An app wants to connect to SEOpen. Sign in, then choose what it may do.</p>}
        {error && <Callout tone="bad" title={error} />}
        <SignInForm next={next} google={googleLoginConfigured} />
        <signupPage.SignInFooter />
      </CardBody>
    </Card>
  );
}
