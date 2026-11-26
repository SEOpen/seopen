import "server-only";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { competitors, contentBriefs, projects } from "@/db/schema";
import { BudgetExceededError } from "@/lib/billing/errors";
import { creditsFor } from "@/lib/billing/gates";
import { spendBlock } from "@/lib/billing/spend";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { DataForSEOError } from "@/lib/dataforseo/client";
import { plainActionFailure } from "@/lib/dataforseo/failure-copy";
import { locationName } from "@/lib/dataforseo/locations";
import { serpTarget } from "@/lib/dataforseo/serp-target";
import { OpError, refused, type Actor, type OpOptions } from "@/lib/ops";
import { inScope, workspaceTimeZone, type ProjectScope } from "@/lib/workspace";
import { todayIn } from "@/modules/google/windowing";
import { load, type DfsSpec, type Loaded } from "@/modules/keywords/dfs";
import { rules } from "@/plan-policy/rules";
import { hasSearchOperators } from "@/modules/keywords/lookup-quote";
import { MAX_KEYWORD_LENGTH, type Market } from "@/modules/keywords/requests";
import type { KeywordOverviewResult, SerpResult, SuggestionsResult } from "@/modules/keywords/types";
import { buildBrief } from "./build";
import { linkSuggestions } from "./links";
import { loadLinkData, planLookups, readTop3 } from "./lookups";
import { FIELD_MAX, MAX_MERGED, optionProblems, proposeOptions, resolveSubjects, subjectProblems } from "./templates";
import { PAGE_TYPE_LABEL, PAGE_TYPES, type BriefFill, type BriefOption, type BriefView, type ContentBrief, type PageType } from "./types";

/**
 * Creating and filling in content briefs, shared by Keyword research → Briefs and the MCP server
 * (see `src/lib/ops`). A brief spends research credits only on lookups that aren't saved yet, and
 * only up to `maxCredits`; everything else it reads is the project's own data, or public pages
 * fetched for free.
 */

/** Briefs a project keeps. Past it, a new one is refused rather than an old one deleted. */
export const MAX_BRIEFS = 200;

export interface CreateBriefInput {
  keyword: string;
  pageType: PageType;
  x?: string | null;
  y?: string | null;
  /** Other keywords the same page should target. */
  merged?: string[];
  /** Options for an alternatives, vs or best-for page. Left out, they're proposed from competitors and the top 10. */
  options?: Partial<BriefOption>[];
}

export type CreateOutcome =
  | { state: "preview"; credits: number; keyword: string; pageType: PageType; x: string | null; y: string | null; merged: string[]; message: string }
  | { state: "needs_credits"; credits: number; message: string }
  | { state: "created"; id: number; credits: number; message: string };

const ready = <T,>(l: Loaded<T> | null) => (l?.state === "ready" ? l : null);

async function projectOf(scope: ProjectScope) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  if (!project) throw new OpError("There's no such project in this workspace.");
  return project;
}

const line = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function keywordOf(raw: string): string {
  const k = line(raw).toLowerCase();
  if (!k || k.length > MAX_KEYWORD_LENGTH) throw new OpError(`Give a keyword of 1 to ${MAX_KEYWORD_LENGTH} characters.`);
  if (hasSearchOperators(k)) throw new OpError("A brief is for a search people type, so leave out operators such as site: and quotes.");
  return k;
}

/** Cleans a list of options, keeping only named ones, with text cut to the field limits. */
export function cleanOptions(options: Partial<BriefOption>[]): BriefOption[] {
  const text = (s: string | null | undefined, max: number) => line(s).slice(0, max) || null;
  return options
    .map((o) => ({
      name: text(o.name, FIELD_MAX.optionName) ?? "",
      url: text(o.url, FIELD_MAX.url),
      price: text(o.price, FIELD_MAX.price),
      priceCheckedOn: text(o.priceCheckedOn, 10),
      drawback: (o.drawback ?? "").trim().slice(0, FIELD_MAX.drawback) || null,
    }))
    .filter((o) => o.name);
}

/** Why the dfs lookups failed, in words for the user. */
/** What a failed lookup says, and what the brief's other lookups cost: they came back and are saved, so trying again doesn't charge for them. */
function lookupFailure(e: unknown, spentCredits = 0): never {
  const spent = spentCredits
    ? ` No brief was saved. The other lookups came back and cost ${rules.creditsText(spentCredits)}; they're saved, so trying again only pays for the one that failed.`
    : " No brief was saved, and nothing was charged.";
  if (e instanceof OpError) throw e;
  if (e instanceof BudgetExceededError) throw new OpError(e.message);
  if (e instanceof DataForSEOError) throw new OpError(`${plainActionFailure(e, "content-briefs.create")}${spent}`);
  throw e;
}

export async function createBriefOp(scope: ProjectScope, actor: Actor, input: CreateBriefInput, opts: OpOptions & { maxCredits?: number } = {}): Promise<CreateOutcome> {
  void actor;
  const locked = await projectActionRefusal(scope);
  if (locked) throw refused(locked);
  if (!(PAGE_TYPES as readonly string[]).includes(input.pageType)) throw new OpError(`The page type is one of: ${PAGE_TYPES.join(", ")}.`);
  const keyword = keywordOf(input.keyword);
  const merged = [...new Set((input.merged ?? []).map(line).map((k) => k.toLowerCase()).filter((k) => k && k !== keyword))];
  if (merged.length > MAX_MERGED) throw new OpError(`Merge at most ${MAX_MERGED} other keywords into one page.`);
  for (const k of merged) if (k.length > MAX_KEYWORD_LENGTH || hasSearchOperators(k)) throw new OpError(`“${k.slice(0, 60)}” can't be merged: keep each keyword plain and under ${MAX_KEYWORD_LENGTH} characters.`);

  const project = await projectOf(scope);
  const own = { name: project.name, domain: project.domain };
  const rivals = (await db.select({ domain: competitors.domain }).from(competitors).where(inScope(competitors, scope)).orderBy(asc(competitors.createdAt))).map((c) => c.domain);
  const subjects = resolveSubjects({ pageType: input.pageType, keyword, x: input.x, y: input.y, competitors: rivals, own });
  const subjectIssues = subjectProblems(input.pageType, subjects);
  if (subjectIssues.length) throw new OpError(subjectIssues.join(" "));

  const today = todayIn(await workspaceTimeZone(scope));
  const given = input.options ? cleanOptions(input.options) : null;
  if (given) {
    const issues = optionProblems(input.pageType, given, own, today);
    if (issues.length) throw new OpError(issues.join(" "));
  }

  const [{ n }] = await db.select({ n: count() }).from(contentBriefs).where(inScope(contentBriefs, scope));
  if (n >= MAX_BRIEFS) throw new OpError(`This project already keeps ${MAX_BRIEFS} briefs. Delete some on Keyword research → Briefs first.`);

  const m: Market = { locationCode: project.locationCode, languageCode: project.languageCode };
  const plan = await planLookups(keyword, merged, m, scope.workspaceId);
  const credits = plan.usd > 0 ? creditsFor(plan.usd) : 0;
  if (credits > 0) {
    const blocked = await spendBlock(scope.workspaceId, { research: true });
    if (blocked) throw refused(blocked);
  }
  // "X alternatives" reads as a placeholder in a sentence, so name the subjects when they're known.
  const label = PAGE_TYPE_LABEL[input.pageType].replace(/\bX\b/, subjects.x ?? "X").replace(/\bY\b/, subjects.y ?? "Y");
  const what = `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} brief for “${keyword}”`;
  const price = credits ? `${rules.creditsText(credits)} for the lookups not saved yet` : `${rules.hasPlans ? "no credits" : "nothing"}: every lookup is saved`;
  if (opts.dryRun) return { state: "preview", credits, keyword, pageType: input.pageType, ...subjects, merged, message: `Would create ${what}. It costs ${price}.` };
  if (credits > (opts.maxCredits ?? 0)) return { state: "needs_credits", credits, message: `Creating ${what} costs ${rules.creditsText(credits)}.` };

  // Only the lookups the price covered may be bought. One that was saved when the price was worked
  // out and has gone since comes back idle, and the brief asks for its price instead of paying it.
  const run = (spec: DfsSpec) => ({ run: plan.unpaid.includes(spec), workspaceId: scope.workspaceId, projectId: scope.projectId });
  const specs = [plan.overview, plan.merged, plan.serp, plan.questions];
  const settled = await Promise.allSettled([
    load<KeywordOverviewResult>(plan.overview, run(plan.overview)),
    plan.merged ? load<KeywordOverviewResult>(plan.merged, run(plan.merged)) : null,
    load<SerpResult>(plan.serp, run(plan.serp)),
    load<SuggestionsResult>(plan.questions, run(plan.questions)),
  ]);
  const paidFor = (l: Loaded<unknown> | null, i: number) => (l && l.state === "ready" && !l.cached ? (specs[i]?.estUsd ?? 0) : 0);
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) {
    // The lookups that came back are charged and saved, so the error says so: a retry doesn't pay for them again.
    const usd = settled.reduce((sum, r, i) => sum + (r.status === "fulfilled" ? paidFor(r.value, i) : 0), 0);
    lookupFailure(failed.reason, usd > 0 ? creditsFor(usd) : 0);
  }
  const [overview, mergedRes, serp, questions] = settled.map((r) => (r as PromiseFulfilledResult<Loaded<unknown> | null>).value) as [
    Loaded<KeywordOverviewResult>,
    Loaded<KeywordOverviewResult> | null,
    Loaded<SerpResult>,
    Loaded<SuggestionsResult>,
  ];
  const goneUsd = [overview, mergedRes, serp, questions].reduce((sum, l) => sum + (l?.state === "idle" ? l.estUsd : 0), 0);
  if (goneUsd > 0) return { state: "needs_credits", credits: creditsFor(goneUsd), message: `Creating ${what} costs ${rules.creditsText(creditsFor(goneUsd))} more: a saved lookup it counted on has expired.` };
  const spentUsd = [overview, mergedRes, serp, questions].reduce((sum, l, i) => sum + paidFor(l, i), 0);

  const serpResult = (ready(serp)?.results[0] as SerpResult | undefined) ?? null;
  const now = new Date();
  const [top3, linkData] = await Promise.all([readTop3(serpResult), loadLinkData(scope, keyword)]);
  const serpDomains = (serpResult?.items ?? []).filter((i) => i.type === "organic").map((i) => serpTarget(i).domain ?? "");
  const options = given ?? proposeOptions(input.pageType, subjects, rivals, serpDomains, own);

  const brief: ContentBrief = buildBrief({
    keyword,
    pageType: input.pageType,
    subjects,
    market: { ...m, name: locationName(m.locationCode) },
    own,
    overview: { value: (ready(overview)?.results[0] as KeywordOverviewResult | undefined)?.items?.[0] ?? null, at: ready(overview)?.fetchedAt ?? null },
    merged: mergedRes ? { value: (ready(mergedRes)?.results[0] as KeywordOverviewResult | undefined)?.items ?? [], at: ready(mergedRes)?.fetchedAt ?? null } : null,
    serp: { value: serpResult, at: ready(serp)?.fetchedAt ?? null, aioLoaded: plan.serpAio },
    questions: { value: (ready(questions)?.results[0] as SuggestionsResult | undefined)?.items ?? [], at: ready(questions)?.fetchedAt ?? null },
    top3: { value: top3, at: now },
    links: linkSuggestions({ keyword, ...linkData }),
    options,
    now,
  });

  const spent = spentUsd > 0 ? creditsFor(spentUsd) : 0;
  const [row] = await db
    .insert(contentBriefs)
    .values({ ...scope, keyword, pageType: input.pageType, brief, fill: given ? { options: given } : {}, creditsSpent: spent, createdAt: now, updatedAt: now })
    .returning({ id: contentBriefs.id });
  return { state: "created", id: row.id, credits: spent, message: `Created ${what}${spent ? ` for ${rules.creditsText(spent)}` : ", using saved lookups only"}.` };
}

const toView = (row: typeof contentBriefs.$inferSelect): BriefView => ({
  id: row.id,
  keyword: row.keyword,
  pageType: row.pageType as PageType,
  brief: row.brief as ContentBrief,
  fill: (row.fill ?? {}) as BriefFill,
  creditsSpent: row.creditsSpent,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export async function getBrief(scope: ProjectScope, id: number): Promise<BriefView | null> {
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) return null;
  const [row] = await db
    .select()
    .from(contentBriefs)
    .where(and(eq(contentBriefs.id, id), inScope(contentBriefs, scope)));
  return row ? toView(row) : null;
}

/** The project's briefs, newest first. */
export async function listBriefs(scope: ProjectScope): Promise<BriefView[]> {
  const rows = await db
    .select()
    .from(contentBriefs)
    .where(inScope(contentBriefs, scope))
    .orderBy(desc(contentBriefs.createdAt), desc(contentBriefs.id))
    .limit(MAX_BRIEFS);
  return rows.map(toView);
}

/**
 * Writes the owner's answers into a brief. Only the parts given change. Options are held to the page
 * type's rules on every save: 5 to 8 on an alternatives page, the site itself never first, and a
 * checked-on date for every price.
 */
export async function updateBriefFillOp(scope: ProjectScope, id: number, change: BriefFill, opts: OpOptions = {}): Promise<{ dryRun: boolean; message: string }> {
  const locked = await projectActionRefusal(scope);
  if (locked) throw refused(locked);
  const view = await getBrief(scope, id);
  if (!view) throw new OpError("There's no such brief in this project.");
  const next: BriefFill = { ...view.fill };
  if (change.angle !== undefined) {
    const angle = (change.angle ?? "").trim();
    if (angle.length > FIELD_MAX.angle) throw new OpError(`Keep the angle to ${FIELD_MAX.angle} characters.`);
    next.angle = angle || null;
  }
  if (change.inputs) {
    const ids = new Set(view.brief.ownerInputs.map((i) => i.id));
    const inputs = { ...(view.fill.inputs ?? {}) };
    for (const [k, v] of Object.entries(change.inputs)) {
      if (!ids.has(k)) continue;
      const text = (v ?? "").trim();
      if (text.length > FIELD_MAX.input) throw new OpError(`Keep each answer to ${FIELD_MAX.input} characters.`);
      if (text) inputs[k] = text;
      else delete inputs[k];
    }
    next.inputs = inputs;
  }
  if (change.options) {
    const project = await projectOf(scope);
    const options = cleanOptions(change.options);
    const issues = optionProblems(view.pageType, options, { name: project.name, domain: project.domain }, todayIn(await workspaceTimeZone(scope)));
    if (issues.length) throw new OpError(issues.join(" "));
    next.options = options;
  }
  if (opts.dryRun) return { dryRun: true, message: "Would save the brief." };
  await db
    .update(contentBriefs)
    .set({ fill: next, updatedAt: new Date() })
    .where(and(eq(contentBriefs.id, id), inScope(contentBriefs, scope)));
  return { dryRun: false, message: "Saved." };
}

/** Deletes one of the project's briefs. True when there was one. */
export async function deleteBrief(scope: ProjectScope, id: number): Promise<boolean> {
  const gone = await db
    .delete(contentBriefs)
    .where(and(eq(contentBriefs.id, id), inScope(contentBriefs, scope)))
    .returning({ id: contentBriefs.id });
  return gone.length > 0;
}
