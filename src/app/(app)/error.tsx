"use client";

import { PageFailure } from "@/components/ui/page-failure";
import { contactEmail, isHostedService } from "@/lib/instance";

/** A page that failed, with the sidebar still there. A failure in the layout itself reaches global-error.tsx. */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  return <PageFailure error={error} retry={retry} help={isHostedService() && contactEmail() ? `If it keeps happening, email ${contactEmail()}.` : "If it keeps happening, the server log has the error."} />;
}
