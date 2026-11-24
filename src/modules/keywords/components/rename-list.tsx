"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { renameList, type RenameState } from "../actions";

/** Rename form that shows a duplicate-name error inline. */
export function RenameList({ listId, name }: { listId: number; name: string }) {
  const [state, action, pending] = useActionState<RenameState, FormData>(renameList.bind(null, listId), { error: null });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      {state.error && (
        <span role="alert" className="text-xs text-bad">
          {state.error}
        </span>
      )}
      <Input name="name" defaultValue={name} required maxLength={80} className="h-7 w-44 text-xs" aria-label="List name" />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        Rename
      </Button>
    </form>
  );
}
