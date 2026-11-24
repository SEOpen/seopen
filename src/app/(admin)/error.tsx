"use client";

import { PageFailure } from "@/components/ui/page-failure";

/** An admin page that failed, with the sidebar still there. A failure in the layout itself reaches global-error.tsx. */
export default function AdminError({ error, retry }: { error: unknown; retry: () => void }) {
  return <PageFailure error={error} retry={retry} help="If it keeps happening, the server logs have the reason." />;
}
