import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { ApiKeyTable } from "@/components/settings/api-key-table";
import { ConnectedAppTable } from "@/components/settings/connected-app-table";
import { NewApiKey } from "@/components/settings/new-api-key";
import { isFree } from "@/lib/billing/gates";
import { appOrigin } from "@/lib/hosts";
import { canResearch, canWrite, listApiKeys } from "@/lib/mcp/keys";
import { listConnectedApps } from "@/lib/mcp/oauth";
import { cn } from "@/lib/utils";
import { rules } from "@/plan-policy/rules";
import { currentWorkspace } from "@/lib/workspace/current";

export const metadata = { title: "MCP" };

/** What a key that may spend on research lookups may do, after "Read and". */
const RESEARCHES = rules.hasPlans ? "spend credits" : "run research lookups";

/** What the Make a key card says a research key can do. */
const RESEARCH_KEY = rules.hasPlans
  ? ` A key that can spend ${rules.researchNoun} can run keyword, domain and backlink lookups, each up to the limit its call names.`
  : " A key that can run research lookups can look up keywords, domains and backlinks, each up to the limit its call names.";

/** What a key or connected app may do beyond reading. */
function accessLabel(grant: { scopes: string[] }) {
  const write = canWrite(grant);
  const research = canResearch(grant);
  if (write && research) return `Read, make changes and ${RESEARCHES}`;
  if (write) return "Read and make changes";
  return research ? `Read and ${RESEARCHES}` : "Read only";
}

/** A connected app's name: what it calls itself, else its address. */
function appName(app: { name: string | null; uri: string | null; clientId: string }) {
  return app.name?.trim() || app.uri || app.clientId;
}

/**
 * The workspace's AI agent access to SEOpen's MCP server: API keys, and apps connected over OAuth
 * (src/lib/mcp/oauth.ts). Usage and limits are on Billing; the owner's spend, caps, ledger and jobs
 * are on /admin/spend.
 */
export default async function AgentsPage() {
  const ws = await currentWorkspace();
  const [keys, apps] = await Promise.all([listApiKeys({ workspaceId: ws.id }), listConnectedApps({ workspaceId: ws.id })]);
  const activeKeys = keys.filter((k) => !k.revokedAt);
  const free = isFree(ws);
  const endpoint = `${appOrigin()}/api/mcp`;

  return (
    <>
      <PageHeader
        title="MCP"
        description="Claude, ChatGPT, Claude Code, Cursor and other AI agents can work with this workspace's SEO data through SEOpen's MCP server, with an app you connect or a key you make."
      />
      {apps.length > 0 && (
        <Section title="Connected apps" className="mt-0">
          <ConnectedAppTable
            rows={apps.map((a) => ({
              id: a.id,
              name: appName(a),
              person: a.email ?? "A former member",
              access: accessLabel({ scopes: a.scopes ?? [] }),
              createdAt: a.createdAt ?? new Date(0),
              lastUsedAt: a.lastUsedAt,
            }))}
          />
        </Section>
      )}
      {activeKeys.length > 0 && (
        <Section title="API keys" className={cn(apps.length > 0 ? "mt-8" : "mt-0")}>
          <ApiKeyTable
            rows={activeKeys.map((k) => ({
              id: k.id,
              name: k.name,
              prefix: k.prefix,
              access: accessLabel(k),
              createdAt: k.createdAt,
              lastUsedAt: k.lastUsedAt,
            }))}
          />
        </Section>
      )}
      <Card className={cn("max-w-2xl", (activeKeys.length > 0 || apps.length > 0) && "mt-8")}>
        <CardHeader
          title="Connect an app"
          description="Add SEOpen as a custom connector in Claude, a custom MCP server in ChatGPT, or in any app that supports remote MCP servers, using this address. The app sends you here to sign in and choose what it may do, with the same choices a key has."
        />
        <CardBody>
          <code className="block rounded-sm bg-surface-2 px-2 py-1 font-mono text-xs break-all">{endpoint}</code>
        </CardBody>
      </Card>
      <Card className="mt-8 max-w-2xl">
        <CardHeader
          title="Make a key"
          description={`A key can read every project and costs nothing. A key that can make changes can also set projects up and start checks, which count against ${rules.hasPlans ? "your plan" : "the workspace's monthly DataForSEO cap"}.${free ? "" : RESEARCH_KEY}`}
        />
        <CardBody>
          <NewApiKey endpoint={endpoint} free={free} />
        </CardBody>
      </Card>
    </>
  );
}
