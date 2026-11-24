"use client";

import type { ReactNode } from "react";
import { Button } from "./button";
import { ConfirmSubmit } from "./confirm-submit";

/**
 * A submit button that spends. Its cost is on the button. It looks primary and runs on one click only
 * when `first` (the page has nothing to show yet, so this is what the page is for). Otherwise it's
 * secondary and asks in place, so a page full of numbers never invites a stray charge.
 *
 * `name` and `value` go on whichever button submits, for a form with more than one kind of run.
 */
export function SpendConfirm({
  children,
  question,
  confirmLabel = "Run",
  first = false,
  pending = false,
  disabled = false,
  name,
  value,
  title,
}: {
  children: ReactNode;
  question: ReactNode;
  confirmLabel?: string;
  first?: boolean;
  pending?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
  title?: string;
}) {
  if (first) {
    return (
      <Button type="submit" name={name} value={value} disabled={disabled || pending} title={title}>
        {children}
      </Button>
    );
  }
  return (
    <ConfirmSubmit size="md" question={question} confirmLabel={confirmLabel} pending={pending} disabled={disabled} name={name} value={value} title={title}>
      {children}
    </ConfirmSubmit>
  );
}
