import { CapMeter } from "@/components/shell/cap-meter";
import { PauseBanner } from "@/components/shell/pause-banner";
import type { PlanShell } from "../policy";

/** A copy without plans (`@/plan-policy/shell`, policy.ts): spend against the cap, and why paid checks pause. */
export const shell: PlanShell = { Banner: PauseBanner, Meter: CapMeter, WorkspaceGrant: () => null };
