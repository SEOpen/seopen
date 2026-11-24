import { useSyncExternalStore } from "react";

/**
 * The project the sidebar has settled on, for the rest of the shell. The layout doesn't re-render on a
 * client navigation, so only the sidebar keeps this up to date, and anything else reads it from here
 * rather than asking the server a second time. Null until the sidebar has rendered.
 */
let shown: string | null = null;
const listeners = new Set<() => void>();

export function setShownProject(id: number | null) {
  const next = id == null ? null : String(id);
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useShownProject(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => null,
  );
}
