import type { Job } from "pg-boss";

/** A background job owned by a module. Registered in src/lib/jobs/registry.ts via the module's jobs.ts. */
export interface JobDef<T extends object = object> {
  /** Queue name, prefixed with the module: "rank.check", "audit.poll". */
  name: string;
  handler: (data: T, job: Job<T>) => Promise<unknown>;
  /** Cron, read in SCHEDULE_TIME_ZONE (src/lib/schedule.ts), to schedule this job; omit for on-demand jobs. */
  cron?: string;
  /** Payload sent with each scheduled run. */
  cronData?: T;
  retryLimit?: number;
  retryDelay?: number;
  expireInSeconds?: number;
  /** Jobs of this queue to run at once in the worker. Default 1. */
  concurrency?: number;
  /** "singleton" keeps at most one queued+active job, handy for sync jobs. */
  policy?: "standard" | "singleton" | "stately";
}

export function defineJob<T extends object>(def: JobDef<T>): JobDef<T> {
  return def;
}

/** A job of any payload type, for module job lists. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyJobDef = JobDef<any>;
