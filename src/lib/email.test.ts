import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboxTakenMessage, sendEmail, welcomeMessage } from "./email";

/** Resend is mocked, so nothing here sends real email. */
const resend = vi.hoisted(() => ({ calls: [] as unknown[][], error: null as { message: string } | null }));
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (...args: unknown[]) => {
        resend.calls.push(args);
        return resend.error ? { data: null, error: resend.error } : { data: { id: "e_1" }, error: null };
      },
    };
  },
}));

// The hosted service's contact address, which core no longer defaults to; "a copy with no contact address" checks the other case.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL", "hello@getseopen.com");
  vi.stubEnv("SEOPEN_SITE_HOST", "getseopen.com");
});

describe("sendEmail", () => {
  const msg = { to: "owner@example.com", subject: "s", html: "<p>h</p>", text: "t" };
  afterEach(() => {
    resend.calls.length = 0;
    resend.error = null;
    vi.unstubAllEnvs();
  });

  it("hands Resend the idempotency key", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await sendEmail(msg, { idempotencyKey: "limit-email/7/2026-11" });
    expect(resend.calls).toHaveLength(1);
    expect(resend.calls[0][0]).toMatchObject(msg);
    expect(resend.calls[0][1]).toEqual({ idempotencyKey: "limit-email/7/2026-11" });
  });

  it("sends no key when none is given", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    await sendEmail(msg);
    expect(resend.calls[0][1]).toBeUndefined();
  });

  it("a retry after a throw sends the same key again", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    resend.error = { message: "timed out" };
    await expect(sendEmail(msg, { idempotencyKey: "welcome-email/u1" })).rejects.toThrow("Resend rejected the message: timed out");
    resend.error = null;
    await sendEmail(msg, { idempotencyKey: "welcome-email/u1" });
    expect(resend.calls.map((c) => c[1])).toEqual([{ idempotencyKey: "welcome-email/u1" }, { idempotencyKey: "welcome-email/u1" }]);
  });

  it("without a key, prints the message in dev but refuses in any production build", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("VERCEL", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendEmail(msg);
    expect(log).toHaveBeenCalledOnce();
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendEmail(msg)).rejects.toThrow("Email is not configured");
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});

describe("links and addresses", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("follow the instance's site host and contact address", () => {
    vi.stubEnv("SEOPEN_SITE_HOST", "seo.example.org");
    vi.stubEnv("NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL", "help@example.org");
    const m = welcomeMessage("https://seo.example.org/projects/new");
    expect(m.html).toContain("https://seo.example.org/email/seopen-lockup-on-light.png");
    expect(m.text).toContain("SEOpen: https://seo.example.org");
    expect(m.html).toContain("help@example.org");
    expect(`${m.html}${m.text}`).not.toContain("getseopen.com");
  });
});

describe("the inbox-taken email", () => {
  it("explains the rule, never names another address, and gives a date only after a delete", () => {
    const taken = inboxTakenMessage({ signInUrl: "https://app.example.com/sign-in" });
    const wait = inboxTakenMessage({ signInUrl: "https://app.example.com/sign-in", until: "Nov 14, 2026" });
    for (const m of [taken, wait]) {
      expect(m.text).toContain("with or without dots");
      expect(m.text).toContain("https://app.example.com/sign-in");
      expect(m.html).toContain("https://app.example.com/sign-in");
      expect(m.text).not.toMatch(/@|—/);
    }
    expect(taken.subject).toBe("You already have a SEOpen account");
    expect(wait.text).toContain("from Nov 14, 2026");
  });
});

describe("lifecycle email copy", () => {
  it("never names dollars, the data provider or a job, and has no em dash", () => {
    const m = welcomeMessage("https://app.example.com/projects/new");
    for (const copy of [m.subject, m.text]) {
      expect(copy).not.toMatch(/\$|dollar|dataforseo|\bjobs?\b|—/i);
    }
  });
});

describe("welcome email", () => {
  const NEW = "https://app.example.com/projects/new";
  // Built per test, after the contact address is stubbed.
  let m: ReturnType<typeof welcomeMessage>;
  beforeEach(() => {
    m = welcomeMessage(NEW);
  });
  const order = (copy: string, words: string[]) => {
    const at = words.map((w) => copy.indexOf(w));
    for (const i of at) expect(i).toBeGreaterThan(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  };

  // The first-run path every plan has, Free included: audit, the fix list, then an agent to work through it.
  it("walks through the audit, the fix list and connecting an agent, in that order", () => {
    for (const copy of [m.text, m.html]) order(copy, ["site audit", "Fixes", "MCP page"]);
  });

  it("leads with nothing Free doesn't have", () => {
    expect(m.text).not.toMatch(/rank|competitor|keyword|AI visibility|backlink/i);
  });

  it("keeps the button to add a site, the reason it was sent and the contact line", () => {
    for (const copy of [m.text, m.html]) {
      expect(copy).toContain(NEW);
      expect(copy).toContain("You're getting this once, because you opened a SEOpen account.");
    }
    expect(m.html).toContain(">Add your site</a>");
    expect(m.html).toContain("hello@getseopen.com");
    expect(m.subject).toBe("Welcome to SEOpen");
  });
});

describe("the postal address footer", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("puts SEOPEN_POSTAL_ADDRESS in every email, in both parts", () => {
    vi.stubEnv("SEOPEN_POSTAL_ADDRESS", "Fernhill Garden Co., 1 Example St, Springfield");
    for (const m of [welcomeMessage("https://app.example.com/projects/new"), inboxTakenMessage({ signInUrl: "https://app.example.com/sign-in" })]) {
      expect(m.html).toContain("<br>Fernhill Garden Co., 1 Example St, Springfield</p>");
      expect(m.text.endsWith("\nFernhill Garden Co., 1 Example St, Springfield")).toBe(true);
    }
  });

  it("leaves the address line out when none is set", () => {
    vi.stubEnv("SEOPEN_POSTAL_ADDRESS", "");
    const m = welcomeMessage("https://app.example.com/projects/new");
    expect(m.text.endsWith("SEOpen: https://getseopen.com")).toBe(true);
    expect(m.html).toContain("write to hello@getseopen.com.</p>");
  });
});

describe("a copy with no contact address", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL", "");
    vi.stubEnv("SEOPEN_POSTAL_ADDRESS", "");
  });
  afterEach(() => {
    resend.calls.length = 0;
    vi.unstubAllEnvs();
  });

  it("refuses to send without EMAIL_FROM, and sends from it once set", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", "");
    const msg = { to: "owner@example.com", subject: "s", html: "<p>h</p>", text: "t" };
    await expect(sendEmail(msg)).rejects.toThrow("Email has no sender. Set EMAIL_FROM");
    expect(resend.calls).toHaveLength(0);
    vi.stubEnv("EMAIL_FROM", "SEOpen <seo@example.org>");
    await sendEmail(msg);
    expect(resend.calls[0][0]).toMatchObject({ from: "SEOpen <seo@example.org>" });
  });

  it("names no address in the footer or the copy, and never SEOpen's own", () => {
    const welcome = welcomeMessage("https://app.example.com/projects/new");
    expect(welcome.html).toContain("Questions? Reply to this email.</p>");
    for (const copy of [welcome.text, welcome.html]) expect(copy).not.toContain("getseopen.com>");
    expect(welcome.html).not.toContain("hello@getseopen.com");
  });
});
