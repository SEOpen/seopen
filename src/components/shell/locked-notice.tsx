"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { use } from "react";
import { Badge } from "@/components/ui/badge";
import { projectIdFromPath } from "@/lib/project-cookie";
import type { ShellData } from "@/lib/shell";
import { rules } from "@/plan-policy/rules";
import { pageProjectId, resolveCurrentId } from "./nav-model";
import { useShownProject } from "./shown-project";

/**
 * Says a locked project is read-only on every page about it. The switcher's badge is out of sight in the
 * drawer on a phone and on the collapsed rail, so this sits in the page, where every width sees it. It
 * reads the shell's one promise and the pathname, so it needs the Suspense the layout gives it.
 */
export function LockedNotice({ shell }: { shell: Promise<ShellData> }) {
  const data = use(shell);
  const pathname = usePathname();
  const known = useShownProject();
  const ids = data.projects.map((p) => p.id);
  const currentId = resolveCurrentId(ids, { path: projectIdFromPath(pathname), known, server: data.currentId });
  const pageId = pageProjectId(pathname, ids, currentId);
  if (!data.projects.find((p) => p.id === pageId)?.locked) return null;
  return (
    <div className="mb-5 flex items-start gap-2 text-xs text-secondary">
      <Badge className="shrink-0">Read-only</Badge>
      <p className="max-w-[69ch] min-w-0 leading-5">
        {rules.plansHref ? (
          <>
            This project&apos;s data stays, but nothing new runs for it, because your plan has fewer projects than this workspace holds. To edit and check it again, archive another project or upgrade in{" "}
            <Link href={rules.plansHref} className="rounded-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
              Billing
            </Link>
            .
          </>
        ) : (
          "This project's data stays, but nothing new runs for it. To edit and check it again, archive another project."
        )}
      </p>
    </div>
  );
}
