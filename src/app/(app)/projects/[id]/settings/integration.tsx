import Link from "next/link";
import type { ReactNode } from "react";

/**
 * One integration: what it's connected to, or where to connect it. `reconnect`: it's mapped, but the account
 * has to be connected again before it updates. An archived project has no module pages to send anyone to, so
 * `connectHref` is null there and the same words stand without a link.
 */
export function Integration({ name, connected, connectHref, reconnect = false }: { name: string; connected: string | null; connectHref: string | null; reconnect?: boolean }) {
  let value: ReactNode = "Not connected";
  if (connected && reconnect) {
    value = (
      <>
        {connected} ·{" "}
        {connectHref ? (
          <Link href={connectHref} className="text-accent underline-offset-2 hover:underline">
            Reconnect needed
          </Link>
        ) : (
          <span className="text-bad">Reconnect needed</span>
        )}
      </>
    );
  } else if (connected) value = connected;
  else if (connectHref)
    value = (
      <Link href={connectHref} className="text-accent underline-offset-2 hover:underline">
        Connect
      </Link>
    );
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted">{name}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}
