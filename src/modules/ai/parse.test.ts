import { describe, expect, it } from "vitest";
import { answerFrom, cleanAnswer } from "./parse";

describe("answerFrom", () => {
  it("skips reasoning items and keeps the message", () => {
    const { text } = answerFrom({
      model_name: "gpt-5.4-mini",
      items: [
        { type: "reasoning", sections: [{ type: "summary_text", text: "**Searching** I should mention Margin" }] },
        { type: "message", sections: [{ type: "text", text: "Try Jotwell." }] },
      ],
    });
    expect(text).toBe("Try Jotwell.");
  });

  it("joins a message's citation fragments without breaking sentences", () => {
    const { text, annotations } = answerFrom({
      model_name: "claude-haiku-5-5",
      items: [
        { type: "message", sections: [{ type: "text", text: "I'll search for current picks." }] },
        {
          type: "message",
          sections: [
            { type: "text", text: "Jotwell is " },
            { type: "text", text: "the best free option", annotations: [{ url: "https://epsilonapps.example/a", title: "Epsilonapps" }] },
            { type: "text", text: ", per Epsilonapps." },
          ],
        },
      ],
    });
    expect(text).toBe("I'll search for current picks.\n\nJotwell is the best free option, per Epsilonapps.");
    expect(annotations).toHaveLength(1);
  });
});

describe("cleanAnswer", () => {
  it("drops ChatGPT's private-use citation blocks", () => {
    expect(cleanAnswer("Jotwell is free.\ue200cite\ue202turn0search3\ue202turn1news2\ue201 Try it.")).toBe("Jotwell is free. Try it.");
  });

  it("keeps the label of entity and url blocks", () => {
    expect(cleanAnswer('Try \ue200entity\ue202["software","Jotwell",0]\ue201 today.')).toBe("Try Jotwell today.");
    expect(cleanAnswer("See \ue200url\ue202View pricing\ue202turn0search4\ue201 for plans.")).toBe("See View pricing for plans.");
  });

  it("cleans the leaked plain forms", () => {
    expect(cleanAnswer("It costs $5 a month. citeturn981235search4turn0news1")).toBe("It costs $5 a month.");
    expect(cleanAnswer("Check urlView pricingturn0search4 first.")).toBe("Check View pricing first.");
    expect(cleanAnswer("Pick urlView pricing on the site.")).toBe("Pick View pricing on the site.");
    expect(cleanAnswer('Use entity["software","Margin","mac app"] instead.')).toBe("Use Margin instead.");
  });

  it("drops source markers and reference numbers but keeps links", () => {
    expect(cleanAnswer("Rated 4.9 on Houzz.[3][9] Open since 2005 【4:0†source】.")).toBe("Rated 4.9 on Houzz. Open since 2005.");
    expect(cleanAnswer("Good value [1, 2] and fast [cite: 3].")).toBe("Good value and fast.");
    expect(cleanAnswer("See [Epsilonapps](https://epsilonapps.example/a) and [1](https://x.com).")).toBe("See [Epsilonapps](https://epsilonapps.example/a) and [1](https://x.com).");
  });

  it("unwraps cite tags", () => {
    expect(cleanAnswer('<cite index="1-2">Jotwell is free</cite>, per Epsilonapps.')).toBe("Jotwell is free, per Epsilonapps.");
  });

  it("leaves ordinary markdown alone", () => {
    const md = "**Top picks**\n\n1. **Jotwell**: free.\n   * Specialties: shared notes.  \n- Plain URL https://example.com/a.";
    expect(cleanAnswer(md)).toBe(md);
  });

  it("is applied to new answers", () => {
    const { text } = answerFrom({ model_name: "gpt-5", items: [{ type: "message", sections: [{ type: "text", text: "Use Jotwell \ue200cite\ue202turn0search1\ue201." }] }] });
    expect(text).toBe("Use Jotwell.");
  });
});
