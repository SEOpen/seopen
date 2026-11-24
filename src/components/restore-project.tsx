"use client";

import { useActionState } from "react";
import { restoreProject, type RestoreState } from "@/app/actions/projects";
import { Button } from "@/components/ui/button";

/** Restores an archived project, or says why the plan won't take it back. */
export function RestoreProject({ projectId, name }: { projectId: number; name: string }) {
  const [state, action, pending] = useActionState<RestoreState>(restoreProject.bind(null, projectId), null);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <Button type="submit" variant="secondary" size="sm" disabled={pending} aria-label={`Restore ${name}`}>
        {pending ? "Restoring…" : "Restore"}
      </Button>
      {state?.error && (
        <p role="status" className="max-w-sm text-right text-xs text-bad">
          {state.error}
        </p>
      )}
    </form>
  );
}
