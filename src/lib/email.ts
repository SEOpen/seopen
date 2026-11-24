import { Resend } from "resend";
import { rules } from "@/plan-policy/rules";
import { siteOrigin } from "@/lib/hosts";
import { contactEmail, postalAddress } from "@/lib/instance";

/** `headers`: extra mail headers, such as the recap's List-Unsubscribe. */
export type OutgoingEmail = { to: string; subject: string; html: string; text: string; headers?: Record<string, string> };

/** The sender: EMAIL_FROM, or SEOpen at the contact address. Null when neither is set. */
function sender(): string | null {
  const from = process.env.EMAIL_FROM?.trim();
  if (from) return from;
  const contact = contactEmail();
  return contact ? `SEOpen <${contact}>` : null;
}

/** " and write to <contact>", or nothing on a copy with no contact address. */
const writeTo = (lead: string) => (contactEmail() ? `${lead} ${contactEmail()}` : "");

export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);

/**
 * Resend when RESEND_API_KEY is set. Locally without a key the message goes to the server log, so
 * verification and reset links still work on 127.0.0.1. A production build without a key refuses to send.
 *
 * `idempotencyKey` goes to Resend as the Idempotency-Key header, so a send that timed out after
 * Resend took it, then retried with the same key, doesn't go out twice. Resend keeps a key for 24
 * hours (1 to 256 characters). The same key with the same message returns the first send's answer;
 * with a different message Resend refuses it (invalid_idempotent_request), which throws here.
 */
export async function sendEmail(msg: OutgoingEmail, opts: { idempotencyKey?: string } = {}): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (key) {
    const from = sender();
    if (!from) throw new Error("Email has no sender. Set EMAIL_FROM to an address on a domain verified in Resend (docs/self-hosting.md, \"Email and alerts\").");
    const { error } = await new Resend(key).emails.send({ from, ...msg }, opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined);
    if (error) throw new Error(`Resend rejected the message: ${error.message}`);
    return;
  }
  // Any production build (Vercel, or `next start` anywhere) refuses, so a self-hosted copy without a key
  // never writes verification and password-reset links to its logs. Only dev and tests print them.
  if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("Email is not configured. Set RESEND_API_KEY.");
  console.log(`[email] to ${msg.to}: ${msg.subject}\n${msg.text}`);
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const SANS = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Helvetica,Arial,sans-serif";

/** The footer's last line: the sender's postal address, or nothing on a copy that sets none. */
function addressText(): string {
  const address = postalAddress();
  return address ? `\n${address}` : "";
}
function addressHtml(): string {
  const address = postalAddress();
  return address ? `<br>${esc(address)}` : "";
}

/**
 * Transactional layout in the brand: flat with hairlines, the lockup as a hosted PNG with
 * its name as the alt text, the main button in the brand blue with white text in both themes. Styles
 * are inline because Gmail drops most of the head; the head adds dark colours for clients that honour
 * prefers-color-scheme (Apple Mail, iOS, Outlook.com) so dark mode gets the brand's dark theme and the
 * lockup drawn for it, not an automatic inversion. The fonts are the reader's own system fonts, so the
 * lockup is the one thing that loads from the web.
 */
function layout(o: { preheader: string; heading: string; paragraphs: string[]; blocks?: string[]; cta: { label: string; url: string }; note: string }) {
  const url = esc(o.cta.url);
  const p = (t: string, extra = "") => `<p class="fg" style="margin:0 0 14px;font:400 15px/1.6 ${SANS};color:#16171b;${extra}">${t}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(o.heading)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.bg{background:#14171c!important}.card{background:#1c2027!important;border-color:#323844!important}
.fg{color:#eef0f3!important}.muted{color:#b8bdc6!important}.rule{border-color:#323844!important}
.link{color:#7ea6f2!important}
.good{border-color:#4cc38a!important}.bad{border-color:#ff7b72!important}
.logo-light{display:none!important}.logo-dark{display:inline-block!important}
}
</style></head>
<body class="bg" style="margin:0;padding:0;background:#f2f1ed">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f1ed"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td class="fg" style="padding:0 4px 20px;font:600 20px/1 ${SANS};color:#16171b"><img class="logo-light" src="${siteOrigin()}/email/seopen-lockup-on-light.png" width="134" height="35" alt="SEOpen" style="display:inline-block;border:0"><img class="logo-dark" src="${siteOrigin()}/email/seopen-lockup-on-dark.png" width="134" height="35" alt="" style="display:none;mso-hide:all;border:0"></td></tr>
<tr><td class="card" style="background:#ffffff;border:1px solid #e1e0dc;border-radius:12px;padding:32px 28px">
<h1 class="fg" style="margin:0 0 16px;font-family:${SANS};font-weight:700;font-size:26px;line-height:1.15;letter-spacing:-0.03em;color:#16171b">${esc(o.heading)}</h1>
${o.paragraphs.map((t) => p(t)).join("\n")}
${(o.blocks ?? []).join("\n")}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 24px"><tr><td style="background:#2f5fc4;border-radius:8px">
<a href="${url}" style="display:inline-block;padding:12px 20px;font:600 15px/20px ${SANS};letter-spacing:-0.01em;color:#ffffff;text-decoration:none;border-radius:8px">${esc(o.cta.label)}</a>
</td></tr></table>
<p class="muted" style="margin:0 0 6px;font:400 13px/1.5 ${SANS};color:#64656a">If the button doesn't work, paste this link into your browser:</p>
<p style="margin:0 0 20px;font:400 13px/1.5 ${SANS};word-break:break-all"><a class="link" href="${url}" style="color:#2f5fc4;text-decoration:underline">${url}</a></p>
<p class="muted rule" style="margin:0;padding-top:16px;border-top:1px solid #e1e0dc;font:400 13px/1.5 ${SANS};color:#64656a">${o.note}</p>
</td></tr>
<tr><td style="padding:20px 4px 0"><p class="muted" style="margin:0;font:400 12px/1.6 ${SANS};color:#64656a">SEOpen · <a class="muted" href="${siteOrigin()}" style="color:#64656a">${new URL(siteOrigin()).host}</a> · Questions? Reply to this email${writeTo(" or write to")}.${addressHtml()}</p></td></tr>
</table></td></tr></table>
</body></html>`;
}

/**
 * For a message written outside this file, such as a hosted service's own email: the layout above,
 * its HTML escaping, and the plain-text footer every message here ends with.
 */
export { layout as emailLayout, esc as escapeEmailHtml };
export const emailTextFooter = () => `SEOpen: ${siteOrigin()}${addressText()}`;

export function verifyEmailMessage(url: string) {
  return {
    subject: "Confirm your SEOpen email",
    html: layout({
      preheader: "One click to finish setting up your SEOpen account.",
      heading: "Confirm your email",
      paragraphs: ["Confirm this address to finish setting up your SEOpen account. You'll choose your password next."],
      cta: { label: "Confirm email", url },
      note: "The link expires in 24 hours. Didn't sign up? Ignore this email and no account is made.",
    }),
    text: `Confirm your SEOpen email\n\nConfirm this address to finish setting up your SEOpen account. You'll choose your password next:\n${url}\n\nThe link expires in 24 hours. Didn't sign up? Ignore this email and no account is made.\n\nSEOpen: ${siteOrigin()}${addressText()}`,
  };
}

/**
 * A sign-up this inbox can't make (src/lib/signup.ts). The form says the same thing for every
 * address, so nobody learns from it which inboxes have an account; this tells the inbox itself.
 * It never names the other address, since a +tag outside Gmail could in theory reach someone else.
 */
export function inboxTakenMessage(o: { signInUrl: string; until?: string }) {
  const why = o.until
    ? `This inbox had a SEOpen account that was deleted recently, so it can make a new one from ${o.until}.`
    : "This inbox already has a SEOpen account, so we didn't make another. Sign in with that account instead. If you've forgotten its password, reset it from the sign-in page.";
  const rule = "SEOpen counts a Gmail address with or without dots, and any address with or without a +tag, as the same inbox.";
  return {
    subject: o.until ? "You can make a new SEOpen account soon" : "You already have a SEOpen account",
    html: layout({
      preheader: o.until ? `This inbox can make a new SEOpen account from ${o.until}.` : "This inbox already has a SEOpen account.",
      heading: o.until ? "Not just yet" : "You already have an account",
      paragraphs: ["Someone, probably you, just tried to make a SEOpen account with this address.", why, rule],
      cta: { label: "Go to sign in", url: o.signInUrl },
      note: "Didn't try to sign up? Ignore this email. Nothing changed.",
    }),
    text: `${o.until ? "Not just yet" : "You already have an account"}\n\nSomeone, probably you, just tried to make a SEOpen account with this address. ${why}\n\n${rule}\n\nSign in: ${o.signInUrl}\n\nDidn't try to sign up? Ignore this email. Nothing changed.\n\nSEOpen: ${siteOrigin()}${addressText()}`,
  };
}

export function resetPasswordMessage(url: string) {
  return {
    subject: "Reset your SEOpen password",
    html: layout({
      preheader: "Choose a new password. The link works once and expires in 1 hour.",
      heading: "Reset your password",
      paragraphs: ["Someone asked to reset the password for your SEOpen account. Use the button to choose a new one."],
      cta: { label: "Choose a new password", url },
      note: "The link works once and expires in 1 hour. Didn't ask for this? Ignore this email; your password stays the same.",
    }),
    text: `Reset your SEOpen password\n\nSomeone asked to reset the password for your SEOpen account. Choose a new one here:\n${url}\n\nThe link works once and expires in 1 hour. Didn't ask for this? Ignore this email; your password stays the same.\n\nSEOpen: ${siteOrigin()}${addressText()}`,
  };
}

export function inviteMessage(url: string, google: boolean) {
  const googleLine = google ? " You can also sign in with Google using this address." : "";
  return {
    subject: "Your SEOpen invite",
    html: layout({
      preheader: "Your place in the SEOpen beta is ready. Choose a password to get in.",
      heading: "You're in",
      paragraphs: [
        "Your place in the SEOpen beta is ready. Choose a password to open your account.",
        `Then add your site.${rules.newAccountLine("invite") ? ` ${rules.newAccountLine("invite")}` : ""}${googleLine}`,
      ],
      cta: { label: "Choose a password", url },
      note: "The link works once and expires in 7 days. Didn't ask to join? Ignore this email.",
    }),
    text: `You're in\n\nYour place in the SEOpen beta is ready. Choose a password to open your account:\n${url}\n\nThen add your site.${rules.newAccountLine("invite") ? ` ${rules.newAccountLine("invite")}` : ""}${googleLine}\n\nThe link works once and expires in 7 days. Didn't ask to join? Ignore this email.\n\nSEOpen: ${siteOrigin()}${addressText()}`,
  };
}

export function adminInviteMessage(url: string) {
  return {
    subject: "Your SEOpen admin account",
    html: layout({
      preheader: "You've been made an SEOpen admin. Choose a password to sign in.",
      heading: "You're an admin",
      paragraphs: ["An SEOpen admin added you as an admin. Choose a password, then sign in and open Admin from the menu."],
      cta: { label: "Choose a password", url },
      note: `The link works once and expires in 7 days. Not expecting this? Ignore this email${writeTo(" and write to")}.`,
    }),
    text: `You're an admin\n\nAn SEOpen admin added you as an admin. Choose a password, then sign in and open Admin from the menu:\n${url}\n\nThe link works once and expires in 7 days. Not expecting this? Ignore this email${writeTo(" and write to")}.\n\nSEOpen: ${siteOrigin()}${addressText()}`,
  };
}

/** The first-run path every plan has, Free included: a site audit, the Fixes list it makes, and an agent to work through it. */
export function welcomeMessage(url: string) {
  const steps = [
    "Start by adding your site and running a site audit. It checks your pages for problems that can hold back search traffic.",
    "Fixes then lists what's worth changing. Mark a fix as changed and SEOpen checks the live page for it and, with Search Console linked, measures what it did.",
    "To make the changes from your own code, connect your coding agent on the MCP page. It reads the same list, works through it on a branch and records each fix.",
  ];
  const note = "You're getting this once, because you opened a SEOpen account.";
  return {
    subject: "Welcome to SEOpen",
    html: layout({
      preheader: "Your account is ready. Add your site, run an audit and work through the fixes.",
      heading: "Welcome to SEOpen",
      paragraphs: ["Your SEOpen account is ready.", ...steps],
      cta: { label: "Add your site", url },
      note,
    }),
    text: `Welcome to SEOpen\n\nYour SEOpen account is ready.\n\n${steps.join("\n\n")}\n\nAdd your site:\n${url}\n\n${note}\n\nSEOpen: ${siteOrigin()}${addressText()}`,
  };
}

/** What the weekly recap email needs about one project. The lines come from src/lib/recap/content.ts. */
export interface RecapSection {
  name: string;
  domain: string;
  href: string;
  lines: RecapEmailLine[];
  /** "3 pages closest to page one" and its lines, when there are any. */
  closest?: { heading: string; lines: RecapEmailLine[] } | null;
  /** "2 alerts this week" and its lines, when there were any. */
  alerts?: { heading: string; lines: RecapEmailLine[] } | null;
}

type RecapEmailLine = { text: string; against: string; tone: "good" | "bad" | "neutral" };

const TONE_BORDER = { good: "#0b7038", bad: "#b80a2a", neutral: "#e1e0dc" } as const;

function recapRowsHtml(lines: RecapEmailLine[]): string {
  return lines
    .map(
      (l) => `<tr><td class="${l.tone === "neutral" ? "rule" : l.tone}" style="padding:2px 0 2px 12px;border-left:3px solid ${TONE_BORDER[l.tone]}">
<p class="fg" style="margin:0;font:400 15px/1.5 ${SANS};color:#16171b">${esc(l.text)}</p>
<p class="muted" style="margin:0;font:400 13px/1.5 ${SANS};color:#64656a">${esc(l.against)}</p>
</td></tr><tr><td style="height:10px;line-height:10px;font-size:0">&nbsp;</td></tr>`,
    )
    .join("\n");
}

function recapSectionHtml(s: RecapSection): string {
  const name = s.name && s.name !== s.domain ? `${esc(s.name)} <span class="muted" style="font-weight:400;color:#64656a">${esc(s.domain)}</span>` : esc(s.domain);
  const block = (b: RecapSection["closest"]) =>
    b?.lines.length
      ? `\n<h3 class="fg" style="margin:6px 0 10px;font:600 15px/1.4 ${SANS};color:#16171b">${esc(b.heading)}</h3>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${recapRowsHtml(b.lines)}</table>`
      : "";
  return `<h2 class="fg" style="margin:24px 0 12px;font:600 17px/1.3 ${SANS};color:#16171b">${name}</h2>
${s.lines.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${recapRowsHtml(s.lines)}</table>` : ""}${block(s.alerts)}${block(s.closest)}
<p style="margin:2px 0 0;font:400 14px/1.5 ${SANS}"><a class="link" href="${esc(s.href)}" style="color:#2f5fc4;text-decoration:underline">Open ${esc(s.name || s.domain)} in SEOpen</a></p>`;
}

/**
 * The weekly recap (src/lib/recap): what moved in each project with something to say, each line
 * with what it's compared with. `weekTo` is the last day of the week it covers, "Nov 2". Its List-Unsubscribe
 * headers give mail apps their own one-click unsubscribe (RFC 8058); the link in the footer asks first.
 */
export function recapMessage(o: { sections: RecapSection[]; weekTo: string; appUrl: string; settingsUrl: string; unsubscribeUrl: string }) {
  const names = o.sections.map((s) => s.name || s.domain);
  const subject = names.length === 1 ? `Your week in SEOpen: ${names[0]}` : `Your week in SEOpen: ${names.length} projects`;
  const intro = `Here's what moved in the week to ${o.weekTo}. Each line says what it's compared with.`;
  const preheader = o.sections[0]?.lines[0]?.text ?? o.sections[0]?.alerts?.lines[0]?.text ?? intro;
  const why = "You're getting this because you turned on the weekly recap in Settings.";
  const note = `${why} <a class="link" href="${esc(o.unsubscribeUrl)}" style="color:#2f5fc4;text-decoration:underline">Unsubscribe</a>, or turn it off in <a class="link" href="${esc(o.settingsUrl)}" style="color:#2f5fc4;text-decoration:underline">Settings</a>.`;
  const textLine = (l: RecapEmailLine) => `- ${l.text} (${l.against})`;
  const textSections = o.sections.map((s) =>
    [`${s.name && s.name !== s.domain ? `${s.name} (${s.domain})` : s.domain}`, ...s.lines.map(textLine), ...(s.alerts?.lines.length ? [`${s.alerts.heading}:`, ...s.alerts.lines.map(textLine)] : []), ...(s.closest?.lines.length ? [`${s.closest.heading}:`, ...s.closest.lines.map(textLine)] : []), `Open: ${s.href}`].join("\n"),
  );
  return {
    subject,
    html: layout({ preheader, heading: "Your week in SEOpen", paragraphs: [esc(intro)], blocks: o.sections.map(recapSectionHtml), cta: { label: "Open SEOpen", url: o.appUrl }, note }),
    text: `Your week in SEOpen\n\n${intro}\n\n${textSections.join("\n\n")}\n\n${why} Unsubscribe: ${o.unsubscribeUrl}\nOr turn it off in Settings: ${o.settingsUrl}\n\nSEOpen: ${siteOrigin()}${addressText()}`,
    headers: { "List-Unsubscribe": `<${o.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

/** One alert in an alert email (src/modules/alerts). `found` is the detection time in the workspace's zone. */
export interface AlertEmailItem {
  title: string;
  detail: string | null;
  source: string;
  found: string;
  urgent: boolean;
  href: string;
}

/**
 * An alert email: every alert for one project not emailed yet, urgent ones first, each with its
 * source, when it was found and a link to the screen. Like the recap, its List-Unsubscribe headers
 * give mail apps a one-click unsubscribe, here from alerts only.
 */
export function alertsMessage(o: { project: { name: string; domain: string }; alerts: AlertEmailItem[]; alertsUrl: string; settingsUrl: string; unsubscribeUrl: string }) {
  const name = o.project.name || o.project.domain;
  const urgent = o.alerts.filter((a) => a.urgent).length;
  const subject =
    o.alerts.length === 1 ? `${o.alerts[0].urgent ? "Urgent: " : ""}${o.alerts[0].title} (${name})` : `${urgent ? "Urgent: " : ""}${o.alerts.length} alerts for ${name}`;
  const intro = o.alerts.length === 1 ? `SEOpen found a problem on ${o.project.domain}.` : `SEOpen found ${o.alerts.length} problems on ${o.project.domain}.`;
  const why = "You're getting this because you get the weekly recap for this workspace. Alerts come at most once a day per project, sooner for a broken page or a blocked crawler.";
  const note = `${why} <a class="link" href="${esc(o.unsubscribeUrl)}" style="color:#2f5fc4;text-decoration:underline">Unsubscribe from alerts</a>, or turn them off in <a class="link" href="${esc(o.settingsUrl)}" style="color:#2f5fc4;text-decoration:underline">Settings</a>.`;
  const meta = (a: AlertEmailItem) => `${a.source}, found ${a.found}`;
  const rows = o.alerts
    .map(
      (a) => `<tr><td class="${a.urgent ? "bad" : "rule"}" style="padding:2px 0 2px 12px;border-left:3px solid ${a.urgent ? TONE_BORDER.bad : TONE_BORDER.neutral}">
<p class="fg" style="margin:0;font:600 15px/1.5 ${SANS};color:#16171b">${esc(a.title)}</p>
${a.detail ? `<p class="fg" style="margin:0;font:400 14px/1.5 ${SANS};color:#16171b">${esc(a.detail)}</p>` : ""}
<p class="muted" style="margin:0;font:400 13px/1.5 ${SANS};color:#64656a">${esc(meta(a))} · <a class="link" href="${esc(a.href)}" style="color:#2f5fc4;text-decoration:underline">Open</a></p>
</td></tr><tr><td style="height:12px;line-height:12px;font-size:0">&nbsp;</td></tr>`,
    )
    .join("\n");
  const textRows = o.alerts.map((a) => [`- ${a.title}`, ...(a.detail ? [`  ${a.detail}`] : []), `  ${meta(a)}: ${a.href}`].join("\n"));
  return {
    subject,
    html: layout({
      preheader: o.alerts[0]?.title ?? intro,
      heading: `Alerts for ${name}`,
      paragraphs: [esc(intro)],
      blocks: [`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`],
      cta: { label: "Open Alerts", url: o.alertsUrl },
      note,
    }),
    text: `Alerts for ${name}\n\n${intro}\n\n${textRows.join("\n\n")}\n\nAll alerts: ${o.alertsUrl}\n\n${why} Unsubscribe from alerts: ${o.unsubscribeUrl}\nOr turn them off in Settings: ${o.settingsUrl}\n\nSEOpen: ${siteOrigin()}${addressText()}`,
    headers: { "List-Unsubscribe": `<${o.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
