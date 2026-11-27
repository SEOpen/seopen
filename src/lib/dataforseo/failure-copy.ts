import { GoogleAccessError } from "@/modules/google/auth";
import { GoogleNotConnectedError, GoogleQuotaError } from "@/modules/google/types";
import { PlausibleAccessError, PlausibleNotConnectedError, PlausibleQuotaError } from "@/modules/plausible/types";
import { PosthogAccessError, PosthogNotConnectedError, PosthogQuotaError } from "@/modules/posthog/types";
import { UmamiAccessError, UmamiNotConnectedError, UmamiQuotaError, UmamiUnreachableError } from "@/modules/umami/types";
import { POSTING_NEVER_FINISHED } from "@/lib/check-failure";
import { OpError } from "@/lib/ops";
import { isHostedService } from "@/lib/instance";
import { BudgetExceededError, DataForSEOError } from "./client";

/**
 * Plain words for a failed call or crawl. The vendor's own text stays in the server logs; customers
 * see what happened and what to do next. Refusals (spend caps, trial limits) are already written
 * for the customer and aren't handled here, except where only their stored text is left.
 *
 * None of this says whether credits were used. A failed HTTP call is released unbilled, but a
 * failed task settles at whatever the response cost, and a page's other calls may have charged.
 */
export interface PlainFailure {
  title: string;
  message: string;
  /** Whether trying the same thing again could work. */
  retry: boolean;
}

/** What the failed call was fetching, from its endpoint. */
function dataName(endpoint: string): string {
  const path = endpoint.replace(/^\/+/, "").replace(/^v3\//, "");
  if (path.startsWith("backlinks/")) return "Backlink data";
  if (path.startsWith("on_page/")) return "Site audit data";
  if (path.startsWith("ai_optimization/")) return "AI answer data";
  if (path.includes("google")) return "Google data";
  return "The data";
}

/** DataForSEO's 405xx task codes: the request itself was rejected, so the same request fails again. */
const isRejectedRequest = (statusCode: number) => statusCode >= 40500 && statusCode < 40600;

/**
 * A 40501 that names `model_name`: DataForSEO no longer takes the model SEOpen asks for (the models in
 * src/modules/ai/platforms.ts). That's SEOpen's own request, not the customer's prompt, so it's never
 * worded as a rejected prompt. Any other 40501 field, and any other 405xx, stays a rejected request.
 */
const isDroppedModel = (statusCode: number, message: string) => statusCode === 40501 && /model_name/i.test(message);

/**
 * Task failures that come and go, so a person's retry can work (docs/dataforseo.md): the two rate
 * limits, 40101 and 40106 (seen on 3 of 54 Live looks) and 40103 (section 5 says to retry it). This
 * only decides what the words and the Retry button say. Nothing here retries on its own, and a Retry
 * shows the price again before it spends.
 */
const TRANSIENT_TASK_CODES: ReadonlySet<number> = new Set([40101, 40103, 40106, 40202, 40209]);

/** Why the DataForSEO account behind a call can't make it. Trying again can't work until whoever runs this copy acts. */
type AccountProblem = "missing" | "login" | "funds" | "daily_limit" | "account";

/**
 * The account behind the call can't make it (docs/dataforseo.md section 5): no credentials at all, the
 * login refused (40100, HTTP 401), no funds (40200, 40210, HTTP 402), the dashboard's daily limit (40203),
 * or another 401xx or 402xx code or HTTP 403. Null for anything else.
 */
function accountProblem({ statusCode, message }: Pick<DataForSEOError, "statusCode" | "message">): AccountProblem | null {
  if (TRANSIENT_TASK_CODES.has(statusCode)) return null;
  if (statusCode === 0) return /credentials/i.test(message) ? "missing" : null;
  if (statusCode === 40100 || statusCode === 401) return "login";
  if (statusCode === 40200 || statusCode === 40210 || statusCode === 402) return "funds";
  if (statusCode === 40203) return "daily_limit";
  if ((statusCode >= 40100 && statusCode < 40300) || statusCode === 403) return "account";
  return null;
}

const OUR_SIDE = "It's a problem on our side, and there's nothing for you to fix.";
const DFS_DASHBOARD = "https://app.dataforseo.com";

/**
 * The next step for an account problem. On the hosted service the customer can't fix it and the owner is
 * alerted, so it says so. On a self-hosted copy the account is its owner's own, so it names the fix.
 */
function accountFix(problem: AccountProblem, statusCode: number): string {
  if (isHostedService()) return OUR_SIDE;
  switch (problem) {
    case "missing":
      return "Add your DataForSEO API login and password to DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in the env file, then restart SEOpen (in Docker: docker compose up -d).";
    case "login":
      return `DataForSEO didn't accept the login in the env file. DATAFORSEO_PASSWORD takes the API password from ${DFS_DASHBOARD}/api-access, not the account one.`;
    case "funds":
      return `The DataForSEO account is out of funds. Add funds at ${DFS_DASHBOARD}, then try again.`;
    case "daily_limit":
      return `The DataForSEO account reached the daily spend limit set in its dashboard. It resets tomorrow, or raise it at ${DFS_DASHBOARD}.`;
    case "account":
      return `DataForSEO refused the account (code ${statusCode}). Check it at ${DFS_DASHBOARD}.`;
  }
}

/** The next step when DataForSEO no longer takes a model SEOpen asks for. A self-hosted copy's owner gets the fix by updating. */
function droppedModelFix(): string {
  return isHostedService() ? OUR_SIDE : "This copy of SEOpen asks for an AI model DataForSEO no longer offers. Update SEOpen (git pull, then docker compose up -d --build), which keeps its models current.";
}

/** The next step for a failure SEOpen can't name: on a self-hosted copy, where its reason is. */
export function unknownFailureNextStep(): string {
  return isHostedService() ? OUR_SIDE : "The reason is in the server log.";
}

/** Words for a failure SEOpen can name, or null when it's something else. */
function knownFailure(error: unknown): PlainFailure | null {
  if (error instanceof DataForSEOError) {
    if (isDroppedModel(error.statusCode, error.message)) return { title: `${dataName(error.endpoint)} isn't available right now`, message: droppedModelFix(), retry: false };
    if (isRejectedRequest(error.statusCode)) {
      return { title: "That lookup didn't work", message: "Check the domain or keyword, then run it again.", retry: false };
    }
    const problem = accountProblem(error);
    if (problem) {
      const title = problem === "missing" && !isHostedService() ? "DataForSEO isn't set up yet" : `${dataName(error.endpoint)} isn't available right now`;
      return { title, message: accountFix(problem, error.statusCode), retry: false };
    }
    return { title: `${dataName(error.endpoint)} didn't come back`, message: "Try again in a minute.", retry: true };
  }
  if (error instanceof GoogleNotConnectedError) {
    if (error.reason !== "not_configured") return { title: "Google isn't connected", message: error.message, retry: false };
    return {
      title: "Google isn't connected",
      message: isHostedService() ? "Google sign-in isn't set up on this server." : "Add a Google OAuth client to GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the env file, then restart SEOpen (in Docker: docker compose up -d). docs/google.md has the steps.",
      retry: false,
    };
  }
  if (error instanceof GoogleAccessError) {
    return { title: "No access to that property", message: "This Google account can't reach that property. Check its access in Google, or reconnect Google.", retry: false };
  }
  if (error instanceof PosthogAccessError) {
    return { title: "No access to that PostHog project", message: "This PostHog connection can't reach that project. Reconnect and grant it.", retry: false };
  }
  if (error instanceof PosthogNotConnectedError) {
    if (error.reason !== "not_configured") return { title: "PostHog isn't connected", message: `${error.message}.`, retry: false };
    return {
      title: "PostHog isn't connected",
      message: isHostedService() ? "PostHog sign-in isn't set up on this server." : "Connecting PostHog needs this copy at an https address that PostHog can reach, set in BETTER_AUTH_URL. docs/posthog.md has the steps.",
      retry: false,
    };
  }
  if (error instanceof PlausibleAccessError) {
    return error.reason === "plan"
      ? { title: "Plausible isn't sharing stats", message: "This Plausible account doesn't include the Stats API, or its subscription has lapsed. The Stats API is on Plausible's Business plan.", retry: false }
      : { title: "No access to that Plausible site", message: "This Plausible key can't reach that site. Pick another site, or connect a key from the team that owns it.", retry: false };
  }
  if (error instanceof PlausibleNotConnectedError) {
    return { title: "Plausible isn't connected", message: `${error.message}.`, retry: false };
  }
  if (error instanceof UmamiAccessError) {
    return { title: "No access to that Umami website", message: "This Umami connection can't reach that website. Pick another, or connect a user or key that can read it.", retry: false };
  }
  if (error instanceof UmamiNotConnectedError) {
    return { title: "Umami isn't connected", message: `${error.message}.`, retry: false };
  }
  if (error instanceof UmamiUnreachableError) {
    return { title: "Your Umami server didn't answer", message: error.message, retry: true };
  }
  if (error instanceof GoogleQuotaError) {
    return { title: "Google is limiting requests", message: "Try again in a few minutes.", retry: true };
  }
  if (error instanceof PosthogQuotaError) {
    return { title: "PostHog is limiting requests", message: "Try again in a few minutes.", retry: true };
  }
  if (error instanceof PlausibleQuotaError) {
    return { title: "Plausible is limiting requests", message: "Try again in a few minutes.", retry: true };
  }
  if (error instanceof UmamiQuotaError) {
    return { title: "Umami is limiting requests", message: "Try again in a few minutes.", retry: true };
  }
  return null;
}

export function plainFailure(error: unknown): PlainFailure {
  return knownFailure(error) ?? { title: "Something went wrong", message: "This part of the page didn't load. Try again in a minute.", retry: true };
}

/** One line for under a form: what failed and what to do. */
export function plainFailureLine(error: unknown): string {
  const known = knownFailure(error);
  return known ? `${known.title}. ${known.message}` : "Something went wrong. Try again in a minute.";
}

/** The next step for a failure away from a page load (a sync, an inspection), or the caller's words when SEOpen can't name it. */
export function plainNextStep(error: unknown, otherwise: string): string {
  return knownFailure(error)?.message ?? otherwise;
}

/**
 * What a form says when the work behind it fails. A refusal or an OpError is already written for the
 * customer. Anything else goes to the logs under `label` and comes back in plain words.
 */
export function plainActionFailure(error: unknown, label: string): string {
  if (error instanceof OpError || error instanceof BudgetExceededError) return error.message;
  console.error(`[${label}]`, error);
  return plainFailureLine(error);
}

/**
 * A stored refusal, recognised by its wording since the crawl row keeps only the text. Every refusal
 * a customer can get says one of these (failure-copy.test.ts runs them all through); a reworded one
 * would fall through to the general failure, never to vendor text.
 */
export const isStoredRefusal = (text: string) => /paid checks|upgrade now|research credits|research budget|DataForSEO cap of|free plan|read-only/i.test(text);

/** The status code a stored failure starts with, when it has one. */
const storedCode = (text: string) => Number(text.match(/^(\d+) /)?.[1] ?? text.match(/^DataForSEO HTTP (\d+)/)?.[1] ?? 0);

/**
 * What kind of way forward a stored failure has. `refusal`: Billing. `rejected`: trying the same thing
 * again can't work until what was sent changes. `our-side`: the DataForSEO account can't make the call, which a
 * customer of the hosted service can't fix and a self-hosted copy's owner fixes in DataForSEO or the env file.
 * `other`: try again.
 */
export function storedFailureKind(stored: string | null): "refusal" | "rejected" | "our-side" | "other" {
  const text = stored ?? "";
  if (isStoredRefusal(text)) return "refusal";
  if (text === AI_RUN_REJECTED) return "rejected";
  if (text === AI_RUN_UNAVAILABLE || text === AI_RUN_MODEL_GONE) return "our-side";
  const statusCode = storedCode(text);
  if (isDroppedModel(statusCode, text)) return "our-side";
  if (isRejectedRequest(statusCode)) return "rejected";
  return accountProblem({ statusCode, message: text }) ? "our-side" : "other";
}

/**
 * The words for a stored vendor failure that trying again can't fix, or null when it could work. Only
 * the text is left, so the code comes from it: "40501 Invalid Field", "DataForSEO HTTP 402 on on_page/lighthouse".
 */
function storedNoRetry(text: string, service: string, rejected: string): string | null {
  const statusCode = storedCode(text);
  if (isDroppedModel(statusCode, text)) return `${service} isn't available right now. ${droppedModelFix()}`;
  if (isRejectedRequest(statusCode)) return rejected;
  const problem = accountProblem({ statusCode, message: text });
  return problem ? `${service} isn't available right now. ${accountFix(problem, statusCode)}` : null;
}

/**
 * The text to store for a failed call. A task failure keeps its code ahead of the words, which is
 * what storedNoRetry reads back. An HTTP failure already names its status.
 */
export function storedFailure(error: unknown): string {
  if (error instanceof DataForSEOError && error.statusCode >= 10000) return `${error.statusCode} ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** The stored reasons a crawl stops on the site's side, by the status code at the end of the text. */
const CRAWL_STOPPED: Record<string, string> = {
  site_unreachable: "The crawler couldn't reach the site. The host may be blocking it or timing out.",
  invalid_page_status_code: "The start page returned an error status, so the crawler stopped.",
  forbidden_meta_tag: "The start page has a robots meta tag that forbids crawling.",
  forbidden_robots: "robots.txt forbids crawling the site.",
  forbidden_http_header: "The start page sends an X-Robots-Tag header that forbids crawling.",
  too_many_redirects: "The start page redirects too many times.",
};

/** Stored when the job that posts a crawl can't be queued, so nothing was sent or charged. */
export const CRAWL_NOT_QUEUED = "The crawl couldn't be queued, so it didn't start. Start a new one in a minute.";

/** Stored when a queued crawl's project was archived, or its workspace suspended, before it was posted. A billing refusal stores its own message. */
export const CRAWL_NOT_STARTED = "The crawl didn't start, and nothing was charged.";

/** Stored when a finished crawl's results couldn't be saved, after the tries it gets (src/modules/audit/crawl.ts). */
export const CRAWL_NOT_SAVED = "The crawl finished, but its results couldn't be saved. Start a new one.";

/** Stored when someone stops a crawl before it starts. Their own choice, so it never counts as something needing a look. */
export const CRAWL_CANCELLED = "Cancelled before it started";

/** SEOpen's own stored crawl failures. Anything else in the column is the vendor's text. */
const isOwnCrawlFailure = (text: string) => text.startsWith("The crawl stopped: ") || text === "The crawl did not finish within 12 hours." || text === CRAWL_CANCELLED || text === CRAWL_NOT_QUEUED || text === CRAWL_NOT_STARTED || text === CRAWL_NOT_SAVED;

/** What a failed crawl's stored error says to a customer. `retry` means a new crawl could work. */
export function plainCrawlFailure(stored: string | null): Pick<PlainFailure, "message" | "retry"> {
  const text = stored ?? "";
  if (isStoredRefusal(text)) return { message: text, retry: false };
  const stopped = CRAWL_STOPPED[text.match(/\(([a-z_]+)\)$/)?.[1] ?? ""];
  if (stopped) return { message: stopped, retry: true };
  if (isOwnCrawlFailure(text)) return { message: text, retry: true };
  const noRetry = storedNoRetry(text, "The crawl service", "The crawl service rejected this crawl, so starting it again won't help. Check the project's domain.");
  if (noRetry) return { message: noRetry, retry: false };
  return { message: "The crawl service had a problem, so this crawl didn't finish. Start a new one in a minute.", retry: true };
}

/**
 * The same crawl failure for Overview and All projects. A crawl that stopped for a reason SEOpen hasn't
 * written up keeps the provider's status word in its stored text, which /audit shows and a summary shouldn't.
 */
export function plainCrawlSummary(stored: string | null): Pick<PlainFailure, "message" | "retry"> {
  const plain = plainCrawlFailure(stored);
  return plain.message.startsWith("The crawl stopped: ") ? { ...plain, message: "The crawl stopped before it reached any pages." } : plain;
}

/** What a failed Lighthouse run's stored error says to a customer. The Run button sits right below it. */
export function plainLighthouseFailure(stored: string | null): string {
  const text = stored ?? "";
  if (isStoredRefusal(text)) return text;
  if (text === "Timed out") return "Lighthouse didn't finish in time. Run it again.";
  const noRetry = storedNoRetry(text, "Lighthouse", "Lighthouse rejected this page, so running it again won't help. Check the page's address.");
  if (noRetry) return noRetry;
  return "Lighthouse didn't come back. Run it again in a minute.";
}

/** Stored on an AI run that closed with no answer at all. Written for the customer, since the run row is read as it is. */
export const AI_RUN_NO_ANSWERS = "None of this run's answers came back";
export const AI_RUN_TIMED_OUT = "Timed out: no answer came back in time";
const AI_RUN_REJECTED = "The AI answer service rejected this run's prompts";
const AI_RUN_UNAVAILABLE = "The AI answer service wasn't available for this run";
/** Every answer failed because DataForSEO no longer takes the model asked for. */
const AI_RUN_MODEL_GONE = "The AI answer service no longer offers the model this run asked for";

/** What to store on an AI run that closed with no answer, from what its answers stored. Budget refusals close the run elsewhere. */
export function aiRunFailure(answerErrors: (string | null)[]): string {
  if (answerErrors.length && answerErrors.every((e) => /^(0 )?Timed out/.test(e ?? ""))) return AI_RUN_TIMED_OUT;
  if (answerErrors.length && answerErrors.every((e) => isDroppedModel(storedCode(e ?? ""), e ?? ""))) return AI_RUN_MODEL_GONE;
  const kinds = new Set(answerErrors.map(storedFailureKind));
  if (kinds.size === 1 && kinds.has("rejected")) return AI_RUN_REJECTED;
  if (kinds.size === 1 && kinds.has("our-side")) return AI_RUN_UNAVAILABLE;
  return AI_RUN_NO_ANSWERS;
}

/** What a failed AI run or answer's stored error says to a customer. Anything not recognised is the vendor's text. */
export function plainAiFailure(stored: string | null): string {
  const text = stored ?? "";
  if (isStoredRefusal(text)) return text;
  if (text === POSTING_NEVER_FINISHED) return "This run didn't start.";
  if (/^(0 )?Timed out/.test(text)) return "No answer came back in time. Run it again.";
  if (text === AI_RUN_NO_ANSWERS) return `${AI_RUN_NO_ANSWERS}. Run it again in a minute.`;
  if (text === AI_RUN_REJECTED) return `${AI_RUN_REJECTED}. Running it again won't help unless the wording changes.`;
  if (text === AI_RUN_MODEL_GONE) return `The AI answer service isn't available right now. ${droppedModelFix()}`;
  if (text === AI_RUN_UNAVAILABLE) return `The AI answer service isn't available right now. ${isHostedService() ? OUR_SIDE : `Check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in the env file, and the DataForSEO account at ${DFS_DASHBOARD}.`}`;
  // A run stops like this on a billing refusal too, so this line can't promise that another run would work.
  if (text === "Run stopped before this task was posted") return "The run stopped before this prompt was sent.";
  const noRetry = storedNoRetry(text, "The AI answer service", "The AI answer service rejected this prompt. Running it again won't help unless the wording changes.");
  if (noRetry) return noRetry;
  return "The AI answer service had a problem. Run it again in a minute.";
}

/**
 * A failed call the ledger kept, which is only its status code and endpoint, in the words it would have had
 * in front of the customer. For a scheduled call nobody saw fail: a weekly snapshot, a Mentions refresh.
 */
export function plainCallFailure(statusCode: number, endpoint: string): Pick<PlainFailure, "message" | "retry"> {
  const known = knownFailure(new DataForSEOError(`DataForSEO HTTP ${statusCode} on ${endpoint}`, statusCode, endpoint))!;
  return { message: `${known.title}. ${known.message}`, retry: known.retry };
}

/** What a failed AI Overview check's stored error says to a customer. The next run checks again on its own. */
export function plainAioFailure(stored: string | null): string {
  const text = stored ?? "";
  if (isStoredRefusal(text)) return text;
  if (text === "Run stopped before this task was posted" || text === POSTING_NEVER_FINISHED) return "The run stopped before these keywords were checked.";
  if (/^(0 )?Timed out/.test(text)) return "Google's results didn't come back in time.";
  return storedNoRetry(text, "Google data", "Google rejected these keywords, so checking them again won't help. Check the prompts' keywords.") ?? "Google data didn't come back. The next run checks again.";
}

/** SEOpen's own reasons a rank or Local check, or one of its points, failed. Anything else in those columns is the vendor's text. */
const OWN_CHECK_REASONS = new Set(["Google Maps returned no listings here", "No result after 3 days", "Could not queue the check"]);

/** The reason a customer may read for a failed check or point, or null when the only reason on file is the vendor's. */
export function plainCheckReason(stored: string | null): string | null {
  return stored && (isStoredRefusal(stored) || OWN_CHECK_REASONS.has(stored)) ? stored : null;
}

/** A check row closed, or about to be, because it never got its searches out. */
const NEVER_STARTED = "This check didn't start.";

/** A rank check's stored error, for its row in the runs table. Empty when it has none. */
export function plainRankFailure(stored: string | null): string {
  if (!stored) return "";
  if (stored === POSTING_NEVER_FINISHED) return NEVER_STARTED;
  return plainCheckReason(stored) ?? "Some searches in this check didn't come back.";
}

/** A whole rank check that failed, in the customer's words. A run only fails when no search came back, whatever the text stored. */
export function plainRankRunFailure(stored: string | null): string {
  if (stored === POSTING_NEVER_FINISHED) return NEVER_STARTED;
  return plainCheckReason(stored) ?? storedNoRetry(stored ?? "", "The search service", "The search service rejected this check, so running it again won't help. Check the project's keywords and location.") ?? "None of this check's searches came back.";
}

/** A whole Local check that failed, in the customer's words. */
export function plainLocalFailure(stored: string | null): string {
  if (stored === POSTING_NEVER_FINISHED) return NEVER_STARTED;
  return plainCheckReason(stored) ?? storedNoRetry(stored ?? "", "The map search service", "The map search service rejected this check, so running it again won't help. Check this business's keywords.") ?? "None of this check's map searches came back.";
}

/**
 * The raw text under a sync's status: only for the internal plan, and only when it adds something to
 * the message already shown. Customers read the message alone.
 */
export function syncErrorDetail(sync: { status: string; message: string | null; lastError: string | null }, internal: boolean): string | null {
  if (!internal || !sync.lastError || sync.status === "ok") return null;
  // The message may be the same words with a full stop added.
  return sync.lastError.replace(/\.$/, "") === sync.message?.replace(/\.$/, "") ? null : sync.lastError;
}
