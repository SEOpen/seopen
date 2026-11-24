import { describe, expect, it } from "vitest";
import type { AiBrandMention } from "@/db/schema/ai";
import { buildPromptActions, isThreadSite, statusCounts, type ActionAnswer } from "./action-list";
import { makeBrand, ownBrand } from "./detect";

const brands = [ownBrand({ domain: "fernhill.example", name: "Fernhill" }), makeBrand("rival.example", false), makeBrand("other.example", false, ["Other Co"])];

const at = (day: number, run: number) => `2026-11-${String(day).padStart(2, "0")}T12:00:00.000Z#${String(run).padStart(8, "0")}`;

/** Which tracked brands an answer names. */
const names = (...domains: string[]): AiBrandMention[] =>
  brands.map((b) => ({ domain: b.domain, own: b.own, count: domains.includes(b.domain) ? 1 : 0, firstOffset: null, position: null, cited: false }));

function answer(o: Partial<ActionAnswer> & { run: number; day: number; platform: string; named: boolean; cites?: string[]; mentionsOf?: string[] }): ActionAnswer {
  return {
    runId: o.run,
    promptId: o.promptId ?? 1,
    prompt: o.prompt ?? "best coffee roaster near me",
    platform: o.platform,
    mentioned: o.named,
    citations: (o.cites ?? []).map((url) => ({ url, domain: new URL(url).hostname.replace(/^www\./, "") })),
    mentions: names(...(o.mentionsOf ?? []), ...(o.named ? ["fernhill.example"] : [])),
    failed: o.failed ?? false,
    at: at(o.day, o.run),
  };
}

describe("AI visibility actions", () => {
  it("gives a prompt the site isn't named for a page to write, a list to get on and a thread to join", () => {
    const [p] = buildPromptActions(
      [
        answer({ run: 1, day: 9, platform: "chat_gpt", named: false, cites: ["https://bestof.example/roasters", "https://reddit.com/r/coffee/abc", "https://rival.example/"], mentionsOf: ["rival.example"] }),
        answer({ run: 1, day: 9, platform: "claude", named: false, cites: ["https://bestof.example/roasters"], mentionsOf: ["other.example"] }),
      ],
      brands,
    );
    expect(p).toMatchObject({ state: "not_named", answered: 2, named: 0, missedOn: ["chat_gpt", "claude"], branded: false, runAt: "2026-11-09T12:00:00.000Z", previous: null });
    expect(p.actions.map((a) => [a.kind, a.url])).toEqual([
      ["write", ""],
      ["featured", "https://bestof.example/roasters"],
      ["thread", "https://reddit.com/r/coffee/abc"],
    ]);
    expect(p.actions[1]).toMatchObject({ answers: 2, platforms: ["chat_gpt", "claude"], competitors: ["Other", "rival.example"], status: "open", saved: false });
    expect(p.actions[2]).toMatchObject({ answers: 1, competitors: ["rival.example"] });
  });

  it("skips the page to write when one of the site's own pages is cited, and says why when nothing is left", () => {
    const [p] = buildPromptActions([answer({ run: 1, day: 9, platform: "chat_gpt", named: false, cites: ["https://fernhill.example/beans", "https://rival.example/"] })], brands);
    expect(p.actions).toEqual([]);
    expect(p.noneBecause).toMatch(/cited but not named/);
  });

  it("takes cited pages only from the answers that leave the site out", () => {
    const [p] = buildPromptActions(
      [
        answer({ run: 1, day: 9, platform: "chat_gpt", named: true, cites: ["https://named-me.example/"] }),
        answer({ run: 1, day: 9, platform: "gemini", named: false, cites: ["https://missed-me.example/"] }),
      ],
      brands,
    );
    expect(p).toMatchObject({ state: "not_named", named: 1, answered: 2, missedOn: ["gemini"] });
    expect(p.actions.map((a) => a.url)).toEqual(["", "https://missed-me.example/"]);
  });

  it("resolves a prompt only after two runs in a row name the site", () => {
    const missed = answer({ run: 1, day: 2, platform: "chat_gpt", named: false });
    const once = buildPromptActions([missed, answer({ run: 2, day: 9, platform: "chat_gpt", named: true })], brands);
    expect(once[0]).toMatchObject({ state: "confirming", actions: [], previous: { runAt: "2026-11-02T12:00:00.000Z", named: false } });
    const twice = buildPromptActions([missed, answer({ run: 2, day: 9, platform: "chat_gpt", named: true }), answer({ run: 3, day: 16, platform: "chat_gpt", named: true })], brands);
    expect(twice[0].state).toBe("resolved");
    expect(buildPromptActions([answer({ run: 1, day: 9, platform: "chat_gpt", named: true })], brands)[0].state).toBe("confirming");
  });

  it("doesn't count a failed answer or a run that got nothing back", () => {
    const rows = [
      answer({ run: 1, day: 2, platform: "chat_gpt", named: true }),
      answer({ run: 2, day: 9, platform: "chat_gpt", named: true }),
      // Every answer failed: the run says nothing, so the prompt stays resolved.
      answer({ run: 3, day: 16, platform: "chat_gpt", named: false, failed: true }),
    ];
    expect(buildPromptActions(rows, brands)[0]).toMatchObject({ state: "resolved", runId: 2 });
    const partly = [...rows, answer({ run: 4, day: 23, platform: "chat_gpt", named: false, failed: true }), answer({ run: 4, day: 23, platform: "claude", named: true })];
    expect(buildPromptActions(partly, brands)[0]).toMatchObject({ state: "resolved", runId: 4, answered: 1, previous: { named: true } });
  });

  it("tags branded prompts and puts the worst first", () => {
    const list = buildPromptActions(
      [
        answer({ promptId: 1, prompt: "is Fernhill any good", run: 1, day: 9, platform: "chat_gpt", named: false }),
        answer({ promptId: 2, run: 1, day: 9, platform: "chat_gpt", named: true }),
        answer({ promptId: 3, run: 1, day: 9, platform: "chat_gpt", named: false }),
        answer({ promptId: 3, run: 1, day: 9, platform: "claude", named: false }),
      ],
      brands,
    );
    expect(list.map((p) => [p.promptId, p.state, p.branded])).toEqual([
      [3, "not_named", false],
      [1, "not_named", true],
      [2, "confirming", false],
    ]);
  });

  it("applies stored statuses, and only a featured page can be saved to the list", () => {
    const rows = [answer({ run: 1, day: 9, platform: "chat_gpt", named: false, cites: ["https://bestof.example/", "https://www.youtube.com/watch?v=1"] })];
    const saved = new Date();
    const list = buildPromptActions(rows, brands, [
      { promptId: 1, kind: "write", url: "", status: "done", savedAt: null },
      { promptId: 1, kind: "featured", url: "https://bestof.example/", status: "dismissed", savedAt: saved },
      { promptId: 1, kind: "thread", url: "https://www.youtube.com/watch?v=1", status: "open", savedAt: saved },
    ]);
    expect(list[0].actions.map((a) => [a.kind, a.status, a.saved])).toEqual([
      ["write", "done", false],
      ["featured", "dismissed", true],
      ["thread", "open", false],
    ]);
    expect(statusCounts(list)).toEqual({ open: 1, done: 1, dismissed: 1 });
  });

  it("knows the thread sites", () => {
    expect(isThreadSite("old.reddit.com")).toBe(true);
    expect(isThreadSite("youtu.be")).toBe(true);
    expect(isThreadSite("bestof.example")).toBe(false);
  });
});
