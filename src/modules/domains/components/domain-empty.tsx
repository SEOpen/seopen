import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * A domain page before any lookup: the form is the page. Explains a rejected `?q=` instead of the
 * generic prompt. `action` is the form, kept under either message.
 */
export function DomainEmpty({ invalid, title, description, action }: { invalid: string | null; title: string; description: ReactNode; action?: ReactNode }) {
  if (invalid != null) {
    return <EmptyState title="That isn't a domain" description={`“${invalid.slice(0, 80)}” isn't a hostname like example.com, so nothing was looked up.`} action={action} />;
  }
  return <EmptyState title={title} description={description} action={action} />;
}
