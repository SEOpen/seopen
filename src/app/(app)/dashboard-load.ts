import "server-only";
import { cache } from "react";
import type { AnyDashboardModule } from "@/components/ui/module-card";
import { checkGate, type CheckGate } from "@/lib/billing/check-gate";
import { summaryFailure, type CheckFailure } from "@/lib/check-failure";
import type { Project } from "@/lib/projects";
import { DASHBOARD_MODULES } from "./dashboard-modules";

/** A loader slower than this counts as failed ("took too long") instead of holding up the page. */
export const LOAD_TIMEOUT_MS = 5000;

/**
 * What one module's loader gave for a project. `failed` means the loader itself threw. `lastRunFailed`
 * is the other kind: the loader worked, but the source's newest check failed or its connection needs
 * redoing, so whatever it loaded is older than that (see DashboardModule.failures).
 */
export type ModuleResult = (
  | { module: AnyDashboardModule; status: "ok"; data: unknown }
  /** `waiting`: set up, with no results yet (see DashboardModule.waiting). */
  | { module: AnyDashboardModule; status: "empty"; waiting?: string }
  | { module: AnyDashboardModule; status: "failed"; slow: boolean }
) & { lastRunFailed?: CheckFailure };

class LoadTimeout extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LoadTimeout(`took longer than ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs every module's loader for one project in parallel, each with its own timeout, in
 * DASHBOARD_MODULES order. A loader that throws or times out fails alone and is logged. Used by
 * the project dashboard and by each row of the projects overview. Cached per request, so the
 * overview's setup note reuses the rows' results instead of querying again.
 */
export const loadModules = cache(async function loadModules(project: Project): Promise<ModuleResult[]> {
  const settled = await Promise.allSettled(DASHBOARD_MODULES.map((m) => withTimeout(m.load(project), LOAD_TIMEOUT_MS)));
  return Promise.all(
    DASHBOARD_MODULES.map(async (module, i): Promise<ModuleResult> => {
      const result = settled[i];
      if (result.status === "rejected") {
        console.error(`[dashboard] ${module.id} failed to load for project ${project.id}`, result.reason);
        return { module, status: "failed", slow: result.reason instanceof LoadTimeout };
      }
      if (result.value != null) return { module, status: "ok", data: result.value };
      const waiting = module.waiting ? await withTimeout(module.waiting(project), LOAD_TIMEOUT_MS).catch(() => null) : null;
      return waiting ? { module, status: "empty", waiting } : { module, status: "empty" };
    }),
  );
});

/** Which sources need a look, by project and then module id. */
export type ProjectFailures = Map<number, Map<string, CheckFailure>>;

/**
 * Asks every module once for all these projects, so All projects costs the same few queries with two
 * projects or fifty. Missing a failure is better than losing the page, so one that can't be read is logged and skipped.
 * Each goes through the plan first: a check the plan rules out raises no alarm, and one refused for now doesn't offer to run again.
 */
export async function loadFailures(projects: Project[], timeZone: string): Promise<ProjectFailures> {
  const out: ProjectFailures = new Map(projects.map((p) => [p.id, new Map()]));
  if (!projects.length) return out;
  let gate: CheckGate;
  try {
    gate = await withTimeout(checkGate(projects[0].workspaceId), LOAD_TIMEOUT_MS);
  } catch (err) {
    console.error("[dashboard] couldn't read what the plan allows, so no failed checks are shown", err);
    return out;
  }
  await Promise.all(
    DASHBOARD_MODULES.map(async (module) => {
      const read = module.failures;
      if (!read) return;
      const found = await readFailures(module.id, () => read(projects, timeZone));
      for (const [projectId, failure] of found) {
        const shown = summaryFailure(failure, gate(module.id, projectId));
        if (shown) out.get(projectId)?.set(module.id, shown);
      }
    }),
  );
  return out;
}

/** Reads a source's failed checks, with the timeout a module's loader has. One that can't be read is logged and comes back empty, so it can't take a page with it. */
export async function readFailures(source: string, read: () => Promise<Map<number, CheckFailure>>): Promise<Map<number, CheckFailure>> {
  try {
    return await withTimeout(read(), LOAD_TIMEOUT_MS);
  } catch (err) {
    console.error(`[dashboard] ${source} couldn't read its failed checks`, err);
    return new Map();
  }
}

/** One project's loader results with what its modules said about their newest checks. */
export function withFailures<R extends { module: Pick<AnyDashboardModule, "id"> }>(results: R[], failures: Map<string, CheckFailure> | undefined): (R & { lastRunFailed?: CheckFailure })[] {
  return results.map((r) => {
    const lastRunFailed = failures?.get(r.module.id);
    return lastRunFailed ? { ...r, lastRunFailed } : r;
  });
}
