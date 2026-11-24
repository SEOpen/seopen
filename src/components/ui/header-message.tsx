"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The line `PageHeader` keeps under its actions, found from where the action sits. Not by id: Next keeps
 * recent pages mounted but hidden, so another page's line can be in the document too. Pure.
 */
export function messageSlot(from: Pick<Element, "closest">): Element | null {
  const next = from.closest("[data-page-header]")?.nextElementSibling;
  return next?.hasAttribute("data-header-message") ? next : null;
}

/**
 * What a button in a page's header has to say after it's pressed. It shows under the header row, so
 * the row itself doesn't reflow to fit it. Outside a `PageHeader` it stays where it's rendered.
 */
export function HeaderMessage({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<Element | null | undefined>(undefined);
  return (
    <>
      <span
        hidden
        ref={(el) => {
          if (el) setSlot(messageSlot(el));
        }}
      />
      {slot === undefined ? null : slot ? createPortal(children, slot) : children}
    </>
  );
}
