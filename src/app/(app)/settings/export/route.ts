import { requireSession } from "@/lib/auth/session";
import { exportPage } from "@/lib/workspace/export";
import { workspaceScope } from "@/lib/workspace/current";

/** GET /settings/export?table=NAME&after=N: one page of one of the current workspace's tables, or of the signed-in account's own, as JSON. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const after = Number(params.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0 || after > 2_147_483_647) return new Response("Bad position", { status: 400 });
  const scope = await workspaceScope();
  const user = await requireSession();
  const page = await exportPage(scope, params.get("table") ?? "", after, { userId: user.id, email: user.email });
  if (!page) return new Response("No such table", { status: 404 });
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}
