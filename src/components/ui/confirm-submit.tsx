"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "@/lib/utils";
import { Button } from "./button";

const noSubscribe = () => () => {};

/**
 * A submit button that asks first, in place: the first click swaps it for the question with
 * Confirm and Cancel, and only Confirm submits the surrounding form. For actions that charge,
 * cut off access or can't be undone. Escape or Cancel puts the button back, with focus on it.
 * `ghost` is for removing a row from a list: quiet until asked, and Confirm is then the danger button.
 *
 * Enter in one of the form's fields asks too. The browser sends Enter to the form's first submit
 * button, and with only a type="button" trigger it would submit a one-field form with no question.
 * So a hidden submit button stands in for the trigger: Enter opens the question. It adds no field
 * to the form. It stays disabled until the page has hydrated, because a disabled first submit
 * button makes Enter do nothing, and before then nothing would stop this one submitting.
 *
 * In a page's header the question doesn't take the button's place, because a wider row would wrap
 * and move the title and everything under it. See `ConfirmQuestion`.
 */
export function ConfirmSubmit({
  children,
  question,
  confirmLabel,
  variant = "secondary",
  size = "sm",
  pending = false,
  disabled = false,
  name,
  value,
  title,
  onOpen,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  /** What Confirm will do, as a question. Null while it's still loading (Upgrade now's amount). */
  question: ReactNode | null;
  confirmLabel: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  pending?: boolean;
  disabled?: boolean;
  /** Sent by Confirm, for a form with more than one kind of submit. */
  name?: string;
  value?: string;
  title?: string;
  /** Runs on the first click, before the question shows. */
  onOpen?: () => void;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const form = useFormStatus();
  const busy = pending || form.pending;

  // A confirmed submit is answered: the question goes, so a refusal shows beside the plain button.
  const [wasBusy, setWasBusy] = useState(busy);
  if (busy !== wasBusy) {
    setWasBusy(busy);
    if (busy) setOpen(false);
  }

  useEffect(() => {
    if (open && question != null) confirmRef.current?.focus();
    // The button is disabled while the submit runs, and can't take focus until it's done.
    if (!open && !busy && returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open, question, busy]);

  // Next keeps recent pages mounted but hidden, so a question left open would still be there on the way back.
  useLayoutEffect(() => () => setOpen(false), []);

  function close() {
    returnFocus.current = true;
    setOpen(false);
  }

  function ask() {
    onOpen?.();
    setOpen(true);
  }

  if (!open || busy) {
    return (
      <>
        <button
          type="submit"
          hidden
          disabled={!hydrated || busy || disabled}
          onClick={(e) => {
            e.preventDefault();
            ask();
          }}
        />
        <Button ref={triggerRef} type="button" variant={variant} size={size} disabled={busy || disabled} aria-label={ariaLabel} title={title} onClick={ask}>
          {children}
        </Button>
      </>
    );
  }

  return (
    <ConfirmQuestion
      question={question}
      confirmLabel={confirmLabel}
      variant={variant}
      size={size}
      name={name}
      value={value}
      label={ariaLabel ?? confirmLabel}
      confirmRef={confirmRef}
      onConfirm={() => {
        returnFocus.current = true;
      }}
      onCancel={close}
    >
      {children}
    </ConfirmQuestion>
  );
}

/**
 * The open question: what Confirm will do, Confirm and Cancel. Elsewhere it takes the button's place in
 * the line. In a `PageHeader` it floats under the header's row instead, at its right edge, over what's
 * below, and an inert copy of the button keeps the button's room, so the row stays as it was. The DOM
 * order is the same either way, so Tab, Escape and Enter work as they do anywhere: Confirm is still the
 * form's first submit button, since the copy is type="button". Exported for its test.
 */
export function ConfirmQuestion({
  children,
  question,
  confirmLabel,
  variant,
  size,
  name,
  value,
  label,
  confirmRef,
  onConfirm,
  onCancel,
}: {
  children: ReactNode;
  question: ReactNode | null;
  confirmLabel: string;
  variant: "primary" | "secondary" | "danger" | "ghost";
  size: "sm" | "md";
  name?: string;
  value?: string;
  label: string;
  confirmRef?: Ref<HTMLButtonElement>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Button type="button" variant={variant} size={size} disabled aria-hidden tabIndex={-1} className="hidden in-[[data-page-header]]:inline-flex">
        {children}
      </Button>
      <span
        role="group"
        aria-label={label}
        className={cn(
          "inline-flex flex-wrap items-center gap-2",
          // In a header (`in-[[data-page-header]]`), placed against the header itself, which is `relative`, so on a phone it never runs off the left edge.
          "in-[[data-page-header]]:absolute in-[[data-page-header]]:top-full in-[[data-page-header]]:right-0 in-[[data-page-header]]:z-20 in-[[data-page-header]]:mt-2 in-[[data-page-header]]:max-w-full in-[[data-page-header]]:justify-end in-[[data-page-header]]:rounded-lg in-[[data-page-header]]:border in-[[data-page-header]]:border-control-edge in-[[data-page-header]]:bg-surface in-[[data-page-header]]:p-3",
        )}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <span className="text-sm" aria-live="polite">
          {question ?? "Checking…"}
        </span>
        <Button
          ref={confirmRef}
          type="submit"
          variant={variant === "secondary" ? "primary" : variant === "ghost" ? "danger" : variant}
          size={size}
          disabled={question == null}
          name={name}
          value={value}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button type="button" variant="secondary" size={size} onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </>
  );
}
