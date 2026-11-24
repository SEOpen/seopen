import { getCurrentProject } from "@/lib/projects";

/**
 * GET /api/projects/current: the project the next page will render, as the switcher needs to know.
 * It sits in the app layout, which doesn't re-render on a client navigation, and the cookie is
 * httpOnly, so the switcher asks here after each one. The proxy requires a session.
 */
export async function GET() {
  const project = await getCurrentProject();
  return Response.json({ id: project?.id ?? null }, { headers: { "Cache-Control": "no-store" } });
}
