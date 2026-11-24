"use client";

import { usePathname } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { missingPage } from "@/lib/missing-page";

/** Inside the app's shell, so the sidebar stays and the way back is the page this one hangs off. */
export function MissingPagePanel() {
  const { message, back } = missingPage(usePathname());
  return <EmptyState level={1} title="Page not found" description={message} action={<ButtonLink href={back.href}>{back.label}</ButtonLink>} />;
}
