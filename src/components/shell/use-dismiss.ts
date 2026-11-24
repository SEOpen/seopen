"use client";

import { useEffect, type RefObject } from "react";

/** While a popover is open: Escape closes it and hands focus back, and a press outside closes it. */
export function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>, button?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      button?.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close, root, button]);
}
