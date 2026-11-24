import type { Refusal } from "@/lib/billing/errors";

/**
 * Operations: the changes the app's Server Actions and the MCP server both make (create a project,
 * track keywords, add prompts, add a Local SEO business, start a check). Each takes a workspace or
 * project scope and the actor, never a session or cookie, and refuses with an `OpError` whose
 * message the caller shows as is. With `dryRun` an operation checks everything, changes nothing and
 * says what it would do, which is what an agent shows the user before it confirms.
 */

/** Who asked for the change: a signed-in user in the app, or an agent with a workspace API key. */
export interface Actor {
  userId: string;
  source: "app" | "mcp";
}

export interface OpOptions {
  /** Check and describe the change without making it. */
  dryRun?: boolean;
}

/** A refused operation. The message is written for the user. */
export class OpError extends Error {
  constructor(
    message: string,
    readonly refusal?: Refusal,
  ) {
    super(message);
    this.name = "OpError";
  }
}

export const refused = (refusal: Refusal) => new OpError(refusal.message, refusal);

export const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
