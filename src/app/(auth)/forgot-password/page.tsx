import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { Card, CardBody } from "@/components/ui/card";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium">Reset your password</h1>
        <ForgotPasswordForm />
        <Link href="/sign-in" className="text-center text-sm text-muted underline">
          Back to sign in
        </Link>
      </CardBody>
    </Card>
  );
}
