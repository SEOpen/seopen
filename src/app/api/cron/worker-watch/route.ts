import { cronAuthorized } from "@/lib/jobs/cron-auth";
import { checkWorker } from "@/lib/jobs/worker-watch";

/**
 * The worker watch (src/lib/jobs/worker-watch.ts), every 5 minutes from a Vercel cron (vercel.json).
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`; proxy.ts lets this path through without a
 * session, so the secret is the only way in. Without CRON_SECRET it refuses everyone, and Admin →
 * Health says the watch isn't running. Any scheduler that sends the header can call it, so a
 * self-hosted copy can run the same check.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET isn't set, so the worker watch can't run." }, { status: 503 });
  if (!cronAuthorized(request.headers.get("authorization"), secret)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(await checkWorker(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    // The state is saved and the claim given back, so the next run sends it again.
    console.error("[worker-watch] check failed", err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
