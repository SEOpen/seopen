"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import { currentThemePreference, setThemePreference, type ThemePreference } from "@/lib/theme";
import { onRadioKey } from "@/lib/radio-keys";
import { cn } from "@/lib/utils";

const subscribe = (onChange: () => void) => {
  window.addEventListener("seopen-theme", onChange);
  return () => window.removeEventListener("seopen-theme", onChange);
};

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "Use system theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
];

/** System, Light or Dark, as the kit's segmented control. System is the default. */
export function ThemeToggle({ className }: { className?: string }) {
  const pref = useSyncExternalStore(subscribe, currentThemePreference, () => "system" as const);
  return (
    <div role="radiogroup" aria-label="Theme" className={cn("inline-flex shrink-0 overflow-hidden rounded-md bg-surface-2/70", className)}>
      {OPTIONS.map(({ value, label, Icon }, i) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          aria-label={label}
          title={label}
          tabIndex={pref === value ? 0 : -1}
          onClick={() => setThemePreference(value)}
          onKeyDown={(e) => onRadioKey(e, i, OPTIONS.length, (next) => setThemePreference(OPTIONS[next].value))}
          className={cn(
            "inline-flex size-7 items-center pointer-coarse:size-11 justify-center transition-colors duration-[120ms] ease-instrument focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
            pref === value ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
          )}
        >
          <Icon aria-hidden className="size-3.5" strokeWidth={1.5} />
        </button>
      ))}
    </div>
  );
}
