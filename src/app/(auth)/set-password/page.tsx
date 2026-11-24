import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { Card, CardBody } from "@/components/ui/card";
import { auth, googleLoginConfigured } from "@/lib/auth";
import { safeCallback } from "@/lib/auth/redirect";
import { hasPassword } from "@/lib/signup";

export const metadata: Metadata = { title: "Choose your password" };

/**
 * Where every confirmation link lands (confirmLink in src/lib/signup.ts), signed in. Opening the
 * link cleared the password typed at sign-up (clearSignupPassword), so the person who owns the
 * inbox chooses one here, or uses Google from now on. A failed link (Better Auth's `?error=`) goes
 * on to /verify-email, which explains it. The proxy lets this page through without a session, as
 * it does the other auth pages, so the page checks for one itself.
 */
export default async function SetPasswordPage({ searchParams }: PageProps<"/set-password">) {
  const sp = await searchParams;
  if (typeof sp.error === "string") redirect(`/verify-email?error=${encodeURIComponent(sp.error)}`);
  const next = safeCallback(sp.next);
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  if (await hasPassword(session.user.id)) redirect(next);

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium">Choose your password</h1>
        <p className="text-sm text-muted">
          Your email is confirmed. Opening the link cleared the password typed at sign-up, so only the person who opens the confirmation email can choose one. You can use the same password again.
        </p>
        <SetPasswordForm next={next} />
        {googleLoginConfigured && (
          <p className="border-t border-line pt-4 text-center text-sm text-muted">
            Rather use Google?{" "}
            <Link className="underline" href={next}>
              Skip this
            </Link>{" "}
            and sign in with Google from now on.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
