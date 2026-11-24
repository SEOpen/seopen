import { SpendRefusedError } from "@/lib/billing/errors";
import type { RefusalCode } from "@/lib/billing/errors";

type Settled = { ok: true } | { ok: false; error: unknown };

/** Whether any of a lookup's loads was refused. Saves asking what the banner says when none was. */
export const anyRefused = (loads: readonly (Settled | null)[]) => loads.some((l) => l && !l.ok && l.error instanceof SpendRefusedError);

/**
 * Which of a lookup's failures to print, in page order. The loads run side by side, so one refusal comes
 * back once per load: it's said once, and not at all when the banner above already says it. Any other
 * failure is about that load and always prints. Pure.
 */
export function failuresToShow(loads: readonly (Settled | null)[], bannerSays: RefusalCode | null | undefined): Set<unknown> {
  const shown = new Set<unknown>();
  const said = new Set<RefusalCode>(bannerSays ? [bannerSays] : []);
  for (const load of loads) {
    if (!load || load.ok) continue;
    if (load.error instanceof SpendRefusedError) {
      if (said.has(load.error.code)) continue;
      said.add(load.error.code);
    }
    shown.add(load.error);
  }
  return shown;
}
