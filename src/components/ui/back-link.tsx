import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { projectIdFromPath } from "@/lib/project-cookie";

/** One level up, above a detail page's title. Opening /projects/<id> switches the project cookie, so a prefetch must never reach it. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} prefetch={projectIdFromPath(href) ? false : undefined} className="mb-2 inline-flex min-h-6 items-center gap-1 rounded-sm text-xs text-muted underline-offset-3 hover:text-fg hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <ArrowLeft aria-hidden className="size-3.5" />
      {children}
    </Link>
  );
}
