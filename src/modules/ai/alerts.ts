/** Owner alerts for AI visibility: a model DataForSEO dropped, and a platform whose answers all failed in a run. */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { settings, workspaces } from "@/db/schema";
import { aiPrompts, aiResults, aiRuns } from "@/db/schema/ai";
import { projects } from "@/db/schema/core";
import { adminUrl, claimAlert, ownerAlertTarget } from "@/lib/billing/alerts";
import { isStoredRefusal } from "@/lib/dataforseo/failure-copy";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { PLATFORMS, platformDef, type PlatformDef, type PlatformKey } from "./platforms";

/**
 * - The daily `billing.alerts` job asks each platform's free `llm_responses/models` list whether it
 *   still offers the model in platforms.ts, and emails the owner when one is gone: every answer on
 *   that platform fails with a 40501 until SEOpen asks for another. It fails closed: a list it can't
 *   read, or one with no model names in it, is logged and alerts nothing, so a change in the list's
 *   shape can't page anyone. Skipped without DataForSEO credentials or any active prompt.
 * - A run that closes with every answer on one platform failed emails the owner too, whatever the
 *   reason: the stored error is in the email. Refusals (spend caps) and answers a stopped run never
 *   sent don't count, and a platform needs at least FAILED_PLATFORM_MIN_ANSWERS answers in the run.
 * - Each goes at most once a UTC day per model or per platform, claimed like the balance alert. A
 *   failed send gives its claim back. Without Resend it logs and claims nothing.
 */

/** A platform with fewer answers in a run than this doesn't alert: one prompt's one failure is too thin to page on. */
export const FAILED_PLATFORM_MIN_ANSWERS = 2;

const STOPPED = "Run stopped before this task was posted";

export const modelAlertKey = (day: string, platform: PlatformKey, model: string) => `platform.ai_model_alert:${day}:${platform}:${model}`;
export const failedPlatformAlertKey = (day: string, platform: PlatformKey) => `platform.ai_platform_alert:${day}:${platform}`;

/** "2026-11-09 14:03 UTC", as the balance alert says it. */
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const asEmail = (subject: string, paragraphs: string[]) => ({ subject, text: paragraphs.join("\n\n"), html: paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") });

/**
 * Pure: the model names in a `models` response, or null when it can't be read as a list of them. An
 * empty list is null too: it says nothing about whether a model is gone.
 */
export function offeredModels(res: unknown): string[] | null {
  const task = (res as { tasks?: unknown[] } | null)?.tasks?.[0] as { status_code?: unknown; result?: unknown } | undefined;
  if (!task || task.status_code !== 20000 || !Array.isArray(task.result)) return null;
  const names = task.result.map((m) => (m as { model_name?: unknown } | null)?.model_name).filter((n): n is string => typeof n === "string" && n.length > 0);
  return names.length ? names : null;
}

export type ModelStatus = { platform: PlatformKey; model: string } & ({ status: "offered" | "missing" } | { status: "unreadable"; error: string });

export interface ModelCheckReads {
  /** Whether DataForSEO credentials are set here. */
  configured: () => boolean;
  /** Whether any active project has an active prompt, so a dropped model would fail a run. */
  promptsActive: () => Promise<boolean>;
  /** The raw `llm_responses/models` response for a platform. */
  listModels: (platform: PlatformKey) => Promise<unknown>;
  now: () => Date;
}

async function anyActivePrompt(): Promise<boolean> {
  const [row] = await db
    .select({ id: aiPrompts.id })
    .from(aiPrompts)
    .innerJoin(projects, eq(projects.id, aiPrompts.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(and(eq(aiPrompts.active, true), eq(projects.archived, false), eq(workspaces.status, "active")))
    .limit(1);
  return !!row;
}

/** The free models list, read fresh. Loaded late, as the balance check loads the client. */
async function readModels(platform: PlatformKey): Promise<unknown> {
  const { dfsGet } = await import("@/lib/dataforseo/client");
  return dfsGet(`ai_optimization/${platform}/llm_responses/models`, { module: "ai", free: true, ttlSeconds: 0 });
}

export function modelAlertMessage(missing: { def: PlatformDef; offered: string[] }[], at: Date) {
  const names = missing.map((m) => m.def.label).join(", ");
  const paragraphs = [
    ...missing.map(
      (m) =>
        `${m.def.label}: DataForSEO's model list for ${m.def.key} no longer has ${m.def.model}, the model SEOpen asks (checked ${utc(at)}). It lists ${m.offered.length} others: ${m.offered.slice(0, 12).join(", ")}${m.offered.length > 12 ? ", ..." : ""}.`,
    ),
    "Until SEOpen asks for a model that's on the list, every answer on that platform fails with a 40501 and the platform's numbers stop updating. The models are in src/modules/ai/platforms.ts. On a self-hosted copy, update SEOpen (git pull, then docker compose up -d --build).",
    `Admin → Health lists failed jobs: ${adminUrl("/admin/health")}`,
    "This alert goes at most once a day for each model.",
  ];
  return asEmail(`SEOpen: DataForSEO no longer offers the ${names} model SEOpen asks for`, paragraphs);
}

/** The daily check: each platform's model against DataForSEO's list, and an email for the ones that are gone. */
export async function checkAiModels(reads: Partial<ModelCheckReads> = {}): Promise<{ skipped: string } | { models: ModelStatus[]; emailed: boolean }> {
  const r: ModelCheckReads = {
    configured: () => !!(env().DATAFORSEO_LOGIN && env().DATAFORSEO_PASSWORD),
    promptsActive: anyActivePrompt,
    listModels: readModels,
    now: () => new Date(),
    ...reads,
  };
  if (!r.configured()) return { skipped: "DataForSEO credentials aren't set" };
  if (!(await r.promptsActive())) return { skipped: "no active AI prompts" };
  const at = r.now();
  const missing: { def: PlatformDef; offered: string[] }[] = [];
  const models = await Promise.all(
    PLATFORMS.map(async (def): Promise<ModelStatus> => {
      const base = { platform: def.key, model: def.model };
      let offered: string[] | null;
      try {
        offered = offeredModels(await r.listModels(def.key));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(`[billing.alerts] couldn't check the ${def.label} model: ${error}`);
        return { ...base, status: "unreadable", error };
      }
      if (!offered) {
        console.warn(`[billing.alerts] couldn't check the ${def.label} model: the models list had no model names`);
        return { ...base, status: "unreadable", error: "no model names in the list" };
      }
      if (offered.includes(def.model)) return { ...base, status: "offered" };
      console.warn(`[billing.alerts] DataForSEO no longer lists ${def.model} for ${def.label}`);
      missing.push({ def, offered });
      return { ...base, status: "missing" };
    }),
  );
  if (!missing.length) return { models, emailed: false };
  const target = ownerAlertTarget();
  if ("off" in target) {
    console.warn(`[billing.alerts] the AI model alert wasn't emailed: ${target.off}`);
    return { models, emailed: false };
  }
  const day = at.toISOString().slice(0, 10);
  const claimed: { def: PlatformDef; offered: string[]; key: string }[] = [];
  for (const m of missing) {
    const key = modelAlertKey(day, m.def.key, m.def.model);
    if (await claimAlert(key)) claimed.push({ ...m, key });
  }
  if (!claimed.length) return { models, emailed: false };
  try {
    await sendEmail({ to: target.to, ...modelAlertMessage(claimed, at) });
  } catch (err) {
    for (const c of claimed) await db.delete(settings).where(eq(settings.key, c.key));
    throw err;
  }
  return { models, emailed: true };
}

export interface FailedPlatform {
  platform: PlatformKey;
  answers: number;
  error: string | null;
}

/**
 * Pure: the platforms whose every answer in a run failed for a reason worth a look. A refusal or an
 * answer a stopped run never sent takes its platform out: the run stopped, the platform didn't fail.
 */
export function failedPlatforms(rows: { platform: string; status: string; error: string | null }[]): FailedPlatform[] {
  const by = new Map<string, typeof rows>();
  for (const row of rows) by.set(row.platform, [...(by.get(row.platform) ?? []), row]);
  const out: FailedPlatform[] = [];
  for (const [platform, answers] of by) {
    if (!platformDef(platform) || answers.length < FAILED_PLATFORM_MIN_ANSWERS) continue;
    const failed = answers.every((a) => a.status === "failed" && a.error !== STOPPED && !isStoredRefusal(a.error ?? ""));
    if (failed) out.push({ platform: platform as PlatformKey, answers: answers.length, error: answers.find((a) => a.error)?.error ?? null });
  }
  return out;
}

export function failedPlatformMessage(f: FailedPlatform & { runId: number; domain: string; at: Date }) {
  const def = platformDef(f.platform)!;
  const model = /model_name/i.test(f.error ?? "")
    ? ` The error names model_name, so DataForSEO most likely no longer offers ${def.model}, the model SEOpen asks (src/modules/ai/platforms.ts). On a self-hosted copy, update SEOpen (git pull, then docker compose up -d --build).`
    : "";
  const paragraphs = [
    `All ${f.answers} ${def.label} answers in AI run ${f.runId} (${f.domain}) failed, closed at ${utc(f.at)}. The first stored error: ${f.error ?? "none stored"}.${model}`,
    `If it's DataForSEO's side, other projects' runs fail the same way until it's fixed. Admin → Health lists failed jobs: ${adminUrl("/admin/health")}`,
    `This alert goes at most once a day for each platform.`,
  ];
  return asEmail(`SEOpen: every ${def.label} answer failed in an AI visibility run`, paragraphs);
}

/**
 * Called once by the call that closed a run. Emails the owner about each platform whose answers all
 * failed. It never throws: the run is closed already, and an alert can't change how.
 */
export async function alertFailedPlatforms(runId: number, now = new Date()): Promise<void> {
  try {
    const rows = await db.select({ platform: aiResults.platform, status: aiResults.status, error: aiResults.error }).from(aiResults).where(eq(aiResults.runId, runId));
    const failed = failedPlatforms(rows);
    if (!failed.length) return;
    const [run] = await db
      .select({ domain: projects.domain })
      .from(aiRuns)
      .innerJoin(projects, and(eq(projects.id, aiRuns.projectId), eq(projects.workspaceId, aiRuns.workspaceId)))
      .where(eq(aiRuns.id, runId));
    const domain = run?.domain ?? "unknown project";
    for (const f of failed) console.warn(`[ai] every ${platformDef(f.platform)!.label} answer in run ${runId} failed: ${f.error ?? "no error stored"}`);
    const target = ownerAlertTarget();
    if ("off" in target) {
      console.warn(`[ai] the failed platform alert wasn't emailed: ${target.off}`);
      return;
    }
    const day = now.toISOString().slice(0, 10);
    for (const f of failed) {
      const key = failedPlatformAlertKey(day, f.platform);
      if (!(await claimAlert(key))) continue;
      try {
        await sendEmail({ to: target.to, ...failedPlatformMessage({ ...f, runId, domain, at: now }) });
      } catch (err) {
        await db.delete(settings).where(eq(settings.key, key));
        throw err;
      }
    }
  } catch (err) {
    console.error(`[ai] couldn't send the failed platform alert for run ${runId}`, err instanceof Error ? err.message : err);
  }
}
