"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { quoteLabel, type LookupQuote } from "../lookup-quote";

const fields = (form: HTMLFormElement) => new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString();

/**
 * A research form's submit. `label` is the price for what's on the page, and that can be saved and free.
 * Once any field differs, it's a new lookup, so the button shows what the form as it stands can cost.
 * `refused`: why the workspace can't spend. The banner says it too, so the button is just off, and Enter in a field does nothing.
 */
export function LookupButton({ children, label, quote, quiet, refused }: { children: ReactNode; label: string; quote: LookupQuote; quiet: boolean; refused?: string | null }) {
  const ref = useRef<HTMLButtonElement>(null);
  // Kept across effect runs: Next hides recent pages and shows them again, and an edit made before that is still an edit.
  const loaded = useRef<string | null>(null);
  // The form's values once they differ from what the page loaded.
  const [edited, setEdited] = useState<string | null>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    // Typed before the page came alive: nothing on the page matches the form, so no value here can count as loaded.
    const typedEarly = Array.from(form.elements).some(
      (el) => (el instanceof HTMLInputElement && el.value !== el.defaultValue) || (el instanceof HTMLSelectElement && Array.from(el.options).some((o) => o.selected !== o.defaultSelected)),
    );
    loaded.current ??= typedEarly ? "" : fields(form);
    const check = () => {
      const now = fields(form);
      setEdited(now === loaded.current ? null : now);
    };
    if (typedEarly) check();
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    // A city pick only re-renders the picker's hidden input, which fires neither event. Clearing the city with the country is the same.
    const watcher = new MutationObserver(check);
    watcher.observe(form, { subtree: true, childList: true, attributes: true, attributeFilter: ["value"] });
    return () => {
      form.removeEventListener("input", check);
      form.removeEventListener("change", check);
      watcher.disconnect();
    };
  }, []);

  return (
    <Button ref={ref} type="submit" variant={quiet ? "secondary" : "primary"} disabled={!!refused} title={refused ?? undefined}>
      {children} <span className="font-normal">({edited == null ? label : quoteLabel(quote, new URLSearchParams(edited))})</span>
    </Button>
  );
}
