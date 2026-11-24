import { Badge } from "@/components/ui/badge";

/** Beside a last known position that no look confirmed: the Rankings table and the Overview's keyword table. */
export function NotConfirmedBadge() {
  return (
    <span title="Google's results left this keyword out on every look today, so this is its last known position.">
      <Badge tone="warn">not confirmed</Badge>
    </span>
  );
}
