import { buildOutline } from "./build";
import { headingDepths } from "./headings";
import { toFill, usesOptions } from "./templates";
import { PAGE_TYPE_LABEL, SERP_TYPE_LABEL, type BriefOption, type BriefView, type ContentBrief, type BriefFill, type OutlineItem, type Source } from "./types";

/** The words a "to fill" field shows until the owner writes it. */
export const TO_FILL = "To fill";

/** The outline as it reads now: the template's per-option headings follow the owner's current options. */
export function currentOutline(brief: ContentBrief, fill: BriefFill): OutlineItem[] {
  return buildOutline(brief.template.pageType, brief.template, currentOptions(brief, fill), brief.top3.pages, brief.questions.paa, brief.questions.keywords);
}

export const currentOptions = (brief: ContentBrief, fill: BriefFill): BriefOption[] => fill.options ?? brief.options;

/** Text from anywhere, safe inside a Markdown line: one line, with Markdown's own characters escaped. */
export function md(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_{}[\]<>#|~])/g, "\\$1");
}

/** A paragraph the owner wrote: line breaks kept, each line escaped. */
const block = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => md(l))
    .join("\n");

const n = (v: number | null) => (v == null ? "no data" : v.toLocaleString("en-US"));

export function exportMarkdown(view: BriefView, day: (iso: string) => string): string {
  const { brief, fill } = view;
  const src = (s: Source | null) => (s ? `Source: ${md(s.label)}${s.at ? `, ${day(s.at)}` : ""}.` : "");
  const t = brief.target;
  const missing = toFill(brief, fill);
  const out: string[] = [];
  const subject = [brief.template.x, brief.template.y].filter(Boolean).map(md).join(" and ");

  out.push(`# Content brief: ${md(view.keyword)}`, "");
  out.push(`- Page type: ${PAGE_TYPE_LABEL[brief.template.pageType]}${subject ? ` (${subject})` : ""}`);
  out.push(`- Market: ${md(brief.market.name)}, ${md(brief.market.languageCode)}`);
  out.push(`- Created: ${day(brief.createdAt)}`);
  out.push(`- ${missing.length ? `${missing.length} field${missing.length === 1 ? "" : "s"} still to fill` : "Nothing left to fill"}`);
  out.push("", "This is a brief, not an article. Write the page from it in your own words, with your own evidence.", "");

  out.push("## 1. Target", "");
  out.push(`- Main keyword: ${md(t.keyword)}. Volume ${n(t.volume)} a month, difficulty ${n(t.kd)}, intent ${md(t.intent ?? "not known")}. ${src(t.source)}`);
  if (t.merged.length) {
    out.push("- Also targeted on this page:");
    for (const k of t.merged) out.push(`  - ${md(k.keyword)}: volume ${n(k.volume)}, difficulty ${n(k.kd)}, intent ${md(k.intent ?? "not known")}`);
    out.push(`  - ${src(t.mergedSource)}`);
  }
  out.push("");

  const s = brief.serp;
  out.push("## 2. What ranks", "");
  if (!s.total) out.push("No top 10 results were found.");
  else {
    out.push(`${s.dominant ? `Mostly ${SERP_TYPE_LABEL[s.dominant].toLowerCase()} pages: ${s.agree} of ${s.total}.` : `No single page type leads: the most common is ${s.agree} of ${s.total}.`} ${src(s.source)}`);
    if (s.warning) out.push("", `**Warning:** ${md(s.warning)}`);
    if (s.fit) out.push("", `**Page type:** ${md(s.fit)}`);
    out.push("");
    for (const g of s.byType) {
      out.push(`- ${SERP_TYPE_LABEL[g.type]} (${g.urls.length})`);
      for (const u of g.urls) out.push(`  - ${md(u)}`);
    }
    const unclassified = s.results.filter((r) => !r.type);
    if (unclassified.length) {
      out.push(`- Not classified (${unclassified.length})`);
      for (const r of unclassified) out.push(`  - ${md(r.url ?? "(address hidden)")}`);
    }
  }
  out.push("");

  const a = brief.aiOverview;
  out.push("## 3. AI Overview", "");
  if (!a.source) out.push("No top 10 lookup, so it isn't known.");
  else if (a.present) {
    out.push(`Google shows an AI Overview. ${a.cited.length ? `It cites ${a.cited.length} page${a.cited.length === 1 ? "" : "s"}:` : "It cites no pages."} ${src(a.source)}`);
    for (const c of a.cited) out.push(`- ${md(c.title ?? c.domain ?? "")}: ${md(c.url ?? c.domain ?? "")}`);
  } else out.push(`No AI Overview in this lookup.${a.loaded ? "" : " This lookup didn't ask Google for one that loads late, so one may still appear."} ${src(a.source)}`);
  out.push("");

  const q = brief.questions;
  out.push("## 4. Questions to answer", "");
  if (q.paa.length) {
    out.push(`People also ask. ${src(q.paaSource)}`);
    for (const p of q.paa) out.push(`- ${md(p)}`);
    out.push("");
  }
  if (q.keywords.length) {
    out.push(`Question keywords. ${src(q.keywordsSource)}`);
    for (const k of q.keywords) out.push(`- ${md(k.keyword)} (volume ${n(k.volume)})`);
  }
  if (!q.paa.length && !q.keywords.length) out.push("No questions were found for this keyword.");
  out.push("");

  out.push("## 5. What the top 3 cover", "");
  if (!brief.top3.pages.length) out.push("There were no organic results to read.");
  for (const p of brief.top3.pages) {
    out.push(`### ${p.position}. ${md(p.title ?? p.domain ?? "Untitled")}`, "", md(p.url ?? p.domain ?? ""));
    if (p.read === "read") {
      const on = brief.top3.source?.at ? ` on ${day(brief.top3.source.at)}` : "";
      out.push("", p.headings.length ? `Headings read from the page${on}:` : `The page had no H1 to H3 headings${on}.`);
      const depths = headingDepths(p.headings);
      p.headings.forEach((h, i) => out.push(`${"  ".repeat(depths[i])}- H${h.level}: ${md(h.text)}`));
    } else out.push("", `Only the title is known: ${md(p.why ?? "")}`);
    out.push("");
  }
  out.push(`**The angle they all miss** (${fill.angle?.trim() ? "filled in" : TO_FILL.toLowerCase()}):`, "", fill.angle?.trim() ? block(fill.angle) : `${TO_FILL}. What does none of the top 3 say that you can?`, "");

  out.push("## 6. Outline", "", "Headings only. Each says where it came from.", "");
  for (const h of currentOutline(brief, fill)) out.push(`${h.level === 3 ? "  " : ""}- H${h.level}: ${md(h.text)} _(${md(h.from)})_`);
  out.push("");

  out.push("## 7. Only you can add these", "", "Required. A page without them reads like every other page on this search.", "");
  for (const i of brief.ownerInputs) {
    const answer = fill.inputs?.[i.id]?.trim();
    out.push(`- [${answer ? "x" : " "}] ${md(i.prompt)}`);
    out.push(answer ? `  ${block(answer).replace(/\n/g, "\n  ")}` : `  ${TO_FILL}.`);
  }
  out.push("");

  if (usesOptions(brief.template.pageType)) {
    const options = currentOptions(brief, fill);
    out.push("## Options", "", brief.template.pageType === "alternatives" ? "5 to 8 options, never your own site first, one real drawback each. Every price needs the date it was checked." : "Every price needs the date it was checked on the vendor's page.", "");
    if (!options.length) out.push(`${TO_FILL}: no options yet.`);
    options.forEach((o, i) => {
      out.push(`${i + 1}. ${md(o.name)}${o.url ? ` (${md(o.url)})` : ""}`);
      out.push(`   - Price: ${o.price?.trim() ? `${md(o.price)}, checked on ${md(o.priceCheckedOn ?? "")}` : TO_FILL}`);
      out.push(`   - Drawback: ${o.drawback?.trim() ? md(o.drawback) : TO_FILL}`);
    });
    out.push("");
  }

  const l = brief.internalLinks;
  out.push("## 8. Internal links", "");
  if (l.note) out.push(md(l.note), "");
  if (l.from.length) {
    out.push("Link to the new page from:");
    for (const x of l.from) out.push(`- ${md(x.url)}: ${md(x.why)} ${src(x.source)}`);
    out.push("");
  }
  if (l.to.length) {
    out.push("Link from the new page to:");
    for (const x of l.to) out.push(`- ${md(x.url)}: ${md(x.why)} ${src(x.source)}`);
    out.push("");
  }
  if (missing.length) {
    out.push("## Still to fill", "");
    for (const m of missing) out.push(`- [ ] ${md(m)}`);
    out.push("");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
