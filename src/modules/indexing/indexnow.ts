import { fetchErrorMessage, safeFetch } from "@/lib/web/fetch";
import { indexNowAnswer, keyFileMatches, keyFileUrl } from "./state";

/** IndexNow's shared endpoint: it passes each submission on to Bing, Yandex, Seznam, Naver and the others. */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

type Fetch = typeof safeFetch;

export type KeyCheck = { ok: true; host: string } | { ok: false; error: string };

/**
 * Whether the site hosts the key file at its root. It must answer 200 at that exact address with
 * the key in it: IndexNow doesn't follow a redirect to another host, so neither does this.
 */
export async function checkKeyFile(host: string, key: string, fetch: Fetch = safeFetch): Promise<KeyCheck> {
  const url = keyFileUrl(host, key);
  try {
    const r = await fetch(url, { maxBytes: 10_000, timeoutMs: 10_000, maxRedirects: 0 });
    if (keyFileMatches(r.status, r.body, key)) return { ok: true, host };
    if (r.status >= 300 && r.status < 400) return { ok: false, error: `${url} redirects somewhere else. IndexNow needs the file at exactly that address.` };
    if (r.status !== 200) return { ok: false, error: `${url} answered HTTP ${r.status}. Upload the file to the site's root.` };
    return { ok: false, error: `${url} is there but doesn't hold the key alone. The file should contain just ${key}.` };
  } catch (err) {
    return { ok: false, error: `${url}: ${fetchErrorMessage(err)}` };
  }
}

export interface SubmitResult {
  status: number | null;
  ok: boolean;
  keyRejected: boolean;
  message: string;
}

/** Sends pages, all on `host`, to IndexNow. Never throws. */
export async function submitToIndexNow(host: string, key: string, urls: string[], fetch: Fetch = safeFetch): Promise<SubmitResult> {
  try {
    const r = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: keyFileUrl(host, key), urlList: urls }),
      timeoutMs: 30_000,
      maxBytes: 100_000,
    });
    return { status: r.status, ...indexNowAnswer(r.status) };
  } catch (err) {
    return { status: null, ok: false, keyRejected: false, message: `IndexNow didn't answer: ${fetchErrorMessage(err)} The pages go again on the next run.` };
  }
}
