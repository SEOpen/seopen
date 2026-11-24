import { Callout } from "@/components/ui/callout";
import { listPauses } from "@/lib/billing/pauses";
import { refusalTitle } from "@/lib/billing/refusal-title";
import { pauseMessage, spendState } from "@/lib/billing/spend";
import { workspaceScope } from "@/lib/workspace/current";

/**
 * The app-wide banner on a copy without plans: shown when paid work can't run (the workspace is
 * suspended, or its cap or the platform cap is reached) or when scheduled checks are paused at one.
 */
export async function PauseBanner() {
  const { workspaceId } = await workspaceScope();
  const [state, pauses] = await Promise.all([spendState(workspaceId), listPauses(workspaceId)]);
  const refusal = state.refusal ?? (pauses[0] ? { code: pauses[0].reason, message: pauseMessage(pauses[0], state) } : null);
  if (!refusal) return null;
  const title = refusalTitle(refusal.code);
  return (
    <div className="mb-5">
      <Callout role="status" tone={refusal.code === "suspended" ? "bad" : "warn"} title={title}>
        <p>
          {refusal.message}
          {pauses.length > 0 && <> {pauses.length === 1 ? "1 scheduled check is" : `${pauses.length} scheduled checks are`} paused.</>}
        </p>
      </Callout>
    </div>
  );
}
