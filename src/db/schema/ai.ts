// Owned by the ai module. See docs/conventions.md.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectScoped, workspaceId } from "./core";

/** A citation in an AI answer: the cited URL and its bare domain. */
export interface AiCitation {
  url: string;
  domain: string;
  title?: string | null;
}

/** Detection result for one brand (the project or a competitor) in one answer. */
export interface AiBrandMention {
  /** Brand key: the project's or competitor's domain. */
  domain: string;
  own: boolean;
  /** Number of matches in the answer text. */
  count: number;
  /** Character offset of the first match, or null when not mentioned. */
  firstOffset: number | null;
  /** 1 = this brand was named first among the tracked brands in the answer. */
  position: number | null;
  /** True when any citation points at this brand's domain(s). */
  cited: boolean;
}

/** A tracked question, asked on a set of AI platforms every week. */
export const aiPrompts = pgTable(
  "ai_prompts",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    prompt: text().notNull(),
    /** Keyword form of the prompt, checked weekly for a Google AI Overview. Null skips the check. */
    keyword: text(),
    /** Platform keys: chat_gpt, perplexity, gemini, claude. */
    platforms: text().array().notNull(),
    /** Optional grouping on the Prompts tab, e.g. "shared notes". Null shows under "No topic". */
    topic: text(),
    /** Where the prompt came from: "manual" or "suggested". */
    source: text().notNull().default("manual"),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.prompt), index().on(t.projectId, t.active), ...projectScoped("ai_prompts", t)],
);

/** One batch of prompt checks for a project (weekly cron or "Run now"). */
export const aiRuns = pgTable(
  "ai_runs",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    trigger: text().notNull().default("manual"),
    /** queued → running → done | failed */
    status: text().notNull().default("queued"),
    estimatedCostUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    tasksTotal: integer().notNull().default(0),
    tasksDone: integer().notNull().default(0),
    error: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.projectId, t.startedAt),
    index().on(t.status),
    // At most one run in progress per project, so two starts at once can't both pay for one.
    uniqueIndex("ai_runs_one_active_per_project")
      .on(t.projectId)
      .where(sql`status in ('queued', 'running')`),
    ...projectScoped("ai_runs", t),
  ],
);

/** One prompt asked on one platform in one run: the answer, its citations and what we detected. */
export const aiResults = pgTable(
  "ai_results",
  {
    id: serial().primaryKey(),
    runId: integer()
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    promptId: integer()
      .notNull()
      .references(() => aiPrompts.id, { onDelete: "cascade" }),
    platform: text().notNull(),
    /** DataForSEO task id (Standard queue); null for Live calls. */
    taskId: text(),
    /** pending → done | failed */
    status: text().notNull().default("pending"),
    model: text(),
    answer: text(),
    citations: jsonb().$type<AiCitation[]>(),
    mentions: jsonb().$type<AiBrandMention[]>(),
    /** Our brand is named in the answer. */
    mentioned: boolean(),
    /** One of our URLs is cited. */
    cited: boolean(),
    /** Our position among tracked brands, 1 = named first. */
    position: integer(),
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.runId, t.promptId, t.platform),
    index().on(t.projectId, t.createdAt),
    index().on(t.promptId, t.platform),
    index().on(t.status),
    ...projectScoped("ai_results", t),
  ],
);

/** Weekly Google AI Overview check of a prompt's keyword form. */
export const aiOverviews = pgTable(
  "ai_overviews",
  {
    id: serial().primaryKey(),
    runId: integer()
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    promptId: integer()
      .notNull()
      .references(() => aiPrompts.id, { onDelete: "cascade" }),
    keyword: text().notNull(),
    taskId: text(),
    status: text().notNull().default("pending"),
    /** An AI Overview appeared on the SERP. */
    present: boolean(),
    /** One of our URLs is among its references. */
    cited: boolean(),
    mentioned: boolean(),
    text: text(),
    references: jsonb().$type<AiCitation[]>(),
    costUsd: numeric({ precision: 12, scale: 6, mode: "number" }),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.runId, t.promptId),
    // Deleting a prompt cascades here.
    index().on(t.promptId),
    index().on(t.projectId, t.createdAt),
    index().on(t.status),
    ...projectScoped("ai_overviews", t),
  ],
);

/** Domain-level LLM Mentions metrics (DataForSEO's AI answer database), refreshed weekly. */
export const aiLlmMentions = pgTable(
  "ai_llm_mentions",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    /** "google" (AI Overviews) or "chat_gpt". */
    platform: text().notNull(),
    domain: text().notNull(),
    own: boolean().notNull().default(false),
    mentions: integer().notNull().default(0),
    aiSearchVolume: numeric({ precision: 16, scale: 0, mode: "number" }).notNull().default(0),
    /** Top source domains for this target: [{ key, mentions }]. */
    topSources: jsonb().$type<{ key: string; mentions: number }[]>(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.projectId, t.fetchedAt), ...projectScoped("ai_llm_mentions", t)],
);

/** Extra names (or domains) for a brand, e.g. "Margin" for deltabarn.example. */
export const aiBrandAliases = pgTable(
  "ai_brand_aliases",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    /** The brand this alias belongs to: the project's domain or a competitor's. */
    domain: text().notNull(),
    alias: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.projectId, t.domain, t.alias), ...projectScoped("ai_brand_aliases", t)],
);

/**
 * What someone decided about one suggested action on AI visibility → Actions. The actions themselves are
 * worked out from the latest answers each time (`modules/ai/action-list.ts`); only what can't be worked
 * out is kept: the status and whether a cited page was saved to the outreach list. No row means open.
 */
export const aiActions = pgTable(
  "ai_actions",
  {
    id: serial().primaryKey(),
    workspaceId: workspaceId(),
    projectId: integer().notNull(),
    promptId: integer()
      .notNull()
      .references(() => aiPrompts.id, { onDelete: "cascade" }),
    /** "write" (write or extend a page), "featured" (get featured on a cited page) or "thread" (join a cited thread). */
    kind: text().notNull(),
    /** The cited page for "featured" and "thread"; empty for "write". */
    url: text().notNull().default(""),
    /** open | done | dismissed */
    status: text().notNull().default("open"),
    /** When a "featured" page was saved to the outreach list; null when it isn't on it. */
    savedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.projectId, t.promptId, t.kind, t.url),
    // Deleting a prompt cascades here.
    index().on(t.promptId),
    ...projectScoped("ai_actions", t),
  ],
);
