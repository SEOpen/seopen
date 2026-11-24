import type { KeyboardEvent } from "react";

/** Where an arrow key moves the selection in a radio group, wrapping at the ends. Null: not a key the group uses. */
export function radioStep(key: string, index: number, count: number): number | null {
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  return null;
}

/** For a radio's onKeyDown: selects the next one and moves focus to it, as the radio role promises. */
export function onRadioKey(e: KeyboardEvent<HTMLElement>, index: number, count: number, select: (index: number) => void) {
  const next = radioStep(e.key, index, count);
  if (next == null) return;
  e.preventDefault();
  select(next);
  e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}
