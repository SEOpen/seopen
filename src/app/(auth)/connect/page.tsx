import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConnectForm } from "@/components/auth/connect-form";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { consentWorkspace, readConsentRequest } from "@/lib/mcp/oauth";

export const metadata: Metadata = { title: "Connect an app" };

/** The query as the provider sent it, repeated names and all. */
function toSearch(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const value of Array.isArray(v) ? v : v == null ? [] : [v]) out.append(k, value);
  return out;
}

/**
 * The OAuth consent page (src/lib/auth/oauth.ts): an app such as Claude asks to use SEOpen's MCP
 * server, and the person says what it may do, with the same choices an API key has. Only the
 * provider's signed address opens it. The answer goes to Better Auth's `/oauth2/consent`, which
 * checks the signature again and sends the browser back to the app.
 */
export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  const search = toSearch(await searchParams);
  const user = await getCurrentUser();
  // proxy.ts already sends a signed-out visitor to sign-in with this query; this covers a session that ended since.
  if (!user) redirect(`/sign-in?${search}`);

  const request = await readConsentRequest(search);
  if (!request) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-4">
          <h1 className="text-base font-medium">This link has expired</h1>
          <p className="text-sm text-secondary">Connecting an app has to be finished within 10 minutes. Go back to the app and connect SEOpen again.</p>
        </CardBody>
      </Card>
    );
  }

  const workspace = await consentWorkspace(user.id);
  const name = request.name?.trim() || "An app";

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <h1 className="text-base font-medium [overflow-wrap:anywhere]">Connect {name} to SEOpen</h1>
        {!workspace ? (
          <Callout tone="bad" title="This account isn't a member of any workspace yet." />
        ) : !workspace.active ? (
          <Callout tone="bad" title={`${workspace.name} is suspended, so apps can't use it.`} />
        ) : (
          <>
            <p className="text-sm text-secondary [overflow-wrap:anywhere]">
              {name}, which sends you back to <span className="font-mono font-medium text-fg">{request.redirectHost}</span>, wants to work with the{" "}
              <span className="font-medium text-fg">{workspace.name}</span> workspace through SEOpen&apos;s MCP server, as{" "}
              <span className="font-medium text-fg">{user.email}</span>. It can do only what you could, and only what you allow here.
            </p>
            <ConnectForm scopes={request.scopes} />
            <div className="flex flex-col gap-1 border-t border-line pt-4 text-xs text-muted [overflow-wrap:anywhere]">
              <p>
                Apps name themselves, so check that address belongs to the app you meant, and only allow this if you just asked an app to connect to SEOpen.
                {request.metadataHost && (
                  <>
                    {" "}
                    The app&apos;s details come from <span className="font-mono">{request.metadataHost}</span>.
                  </>
                )}
              </p>
              <p>You can disconnect it at any time on the MCP page.</p>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
