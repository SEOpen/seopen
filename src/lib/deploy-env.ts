type Env = Record<string, string | undefined>;

/**
 * Whether this process is the hosted service's production deployment: Vercel's own VERCEL_ENV, or
 * SEOPEN_DEPLOY_ENV where the host isn't Vercel. It lets crawlers in (robots.ts, read at build time),
 * accepts a live Stripe key (src/lib/billing/config.ts) and expects the worker watch to be running.
 *
 * On Vercel, VERCEL_ENV alone decides: a copied env file that carries SEOPEN_DEPLOY_ENV=production
 * into a preview (or a `vercel env pull` file, which sets VERCEL_ENV=development) still refuses live
 * keys. Set the flag only on the production web app and its build, never on the worker, CI or a
 * local copy.
 */
export function isProductionDeploy(env: Env = process.env): boolean {
  if (env.VERCEL_ENV !== undefined) return env.VERCEL_ENV === "production";
  return env.SEOPEN_DEPLOY_ENV === "production";
}
