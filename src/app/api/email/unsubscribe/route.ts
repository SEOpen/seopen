import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { appHref } from "@/lib/hosts";
import { verifyUnsubscribeToken, type EmailList } from "@/lib/recap/unsubscribe";

/**
 * The unsubscribe link of the weekly recap (src/lib/recap) and, with `list=alerts`, of alert
 * emails (src/modules/alerts). Public: proxy.ts lets it through, and the
 * signed token says whose email it is. A POST turns that email off at once, which is what a mail
 * app's one-click unsubscribe sends (RFC 8058, the email's List-Unsubscribe-Post header). A GET,
 * from the link in the email, asks first: mail scanners open links, and that mustn't unsubscribe.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f2f1ed;--card:#fff;--fg:#16171b;--muted:#64656a;--rule:#e1e0dc;--accent:#2f5fc4}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1c2027;--fg:#eef0f3;--muted:#b8bdc6;--rule:#323844;--accent:#7ea6f2}}
body{margin:0;background:var(--bg);color:var(--fg);font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
main{max-width:480px;margin:64px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:28px}
h1{margin:0 0 12px;font-size:24px;line-height:1.2;letter-spacing:-0.02em}
p{margin:0 0 14px}a{color:var(--accent)}
button{font-family:inherit;font-size:15px;font-weight:600;line-height:20px;padding:12px 20px;border:0;border-radius:8px;background:#2f5fc4;color:#fff;cursor:pointer}
</style></head><body><main><div class="card"><h1>${esc(title)}</h1>${body}</div></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** The list a link is for: the recap unless it says alerts. Each list signs its own tokens. */
function listOf(request: Request): EmailList {
  return new URL(request.url).searchParams.get("list") === "alerts" ? "alerts" : "recap";
}

const COPY = {
  recap: {
    invalid: "You can turn the weekly recap off in",
    ask: "Stop the weekly recap?",
    askBody: "You'll stop getting the weekly recap email for every workspace you're in. You can turn it back on in Settings.",
    done: "You won't get the weekly recap email any more. To get it again, turn it on in",
  },
  alerts: {
    invalid: "You can turn alert emails off in",
    ask: "Stop alert emails?",
    askBody: "You'll stop getting alert emails for every workspace you're in. The weekly recap and the Alerts page stay as they are. You can turn them back on in Settings.",
    done: "You won't get alert emails any more. Alerts still show on each project's Alerts page. To get the emails again, turn them on in",
  },
} as const;

const settingsLink = () => `<a href="${esc(appHref("/settings"))}">Settings</a>`;

const invalid = (list: EmailList) => page("This link doesn't work", `<p>It may have been copied only in part. ${COPY[list].invalid} ${settingsLink()}.</p>`, 400);

export function GET(request: Request) {
  const list = listOf(request);
  const token = new URL(request.url).searchParams.get("t");
  if (!verifyUnsubscribeToken(token, list)) return invalid(list);
  return page(
    COPY[list].ask,
    `<p>${COPY[list].askBody}</p>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function POST(request: Request) {
  const list = listOf(request);
  const userId = verifyUnsubscribeToken(new URL(request.url).searchParams.get("t"), list);
  if (!userId) return invalid(list);
  await db
    .update(users)
    .set({ ...(list === "alerts" ? { alertEmails: false } : { weeklyRecap: false }), updatedAt: new Date() })
    .where(eq(users.id, userId));
  return page("You're unsubscribed", `<p>${COPY[list].done} ${settingsLink()}.</p>`);
}
