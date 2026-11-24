import { describe, expect, it } from "vitest";
import { canonicalTopic, keywordToPrompt, normalizeTopic, projectPlaces, promptToKeyword, suggestTopics } from "./prompts";

describe("topics", () => {
  it("normalizes and reuses an existing spelling", () => {
    expect(normalizeTopic("  shared   notes ")).toBe("shared notes");
    expect(normalizeTopic("   ")).toBeNull();
    expect(normalizeTopic(null)).toBeNull();
    expect(canonicalTopic("Shared Notes", ["journals", "shared notes"])).toBe("shared notes");
    expect(canonicalTopic("Pricing", ["shared notes"])).toBe("Pricing");
  });

  it("groups suggestions by the words they share", () => {
    const topics = suggestTopics([
      "best shared notes app for mac",
      "shared notes mac",
      "mac journal",
      "best journal for mac 2026",
      "plainpad journal",
      "how to change desktop background",
    ]);
    expect(topics).toEqual(["shared notes", "shared notes", "journal", "journal", "journal", null]);
  });

  it("doesn't group by a word every keyword has, and reuses topics in use", () => {
    expect(suggestTopics(["mac notes", "mac journal", "mac dock"])).toEqual([null, null, null]);
    expect(suggestTopics(["dynamic notes mac", "mac journal"], ["Dynamic notes"])).toEqual(["Dynamic notes", null]);
  });
});

describe("keywords with modifiers", () => {
  it.each([
    ["semrush alternative reddit", "What are the best alternatives to semrush?"],
    ["best seo tools reddit", "What are the best seo tools?"],
    ["alternatives to semrush cheaper", "What are cheaper alternatives to semrush?"],
    ["cheaper semrush alternatives", "What are cheaper alternatives to semrush?"],
    ["free semrush alternatives", "What are the best free alternatives to semrush?"],
    ["semrush alternatives free", "What are the best free alternatives to semrush?"],
    ["seo tools free", "What are the best free seo tools?"],
    ["how to check backlinks free", "How do I check backlinks free?"],
  ])("keywordToPrompt(%s)", (kw, prompt) => {
    expect(keywordToPrompt(kw)).toBe(prompt);
  });

  it.each(["ai visibility", "best brand awareness", "semrush cheaper"])("skips %s, which makes no question", (kw) => {
    expect(keywordToPrompt(kw)).toBe("");
  });

  it("still asks about a thing whose name ends like a quality", () => {
    expect(keywordToPrompt("ai visibility tools")).toBe("What are the best ai visibility tools?");
    expect(keywordToPrompt("best university")).toBe("What is the best university?");
  });
});

describe("local questions", () => {
  const places = ["St. Clair, Ohio", "Riverton, Ohio", "Fairview, Ohio"];

  it.each([
    ["web design riverton", "Who does the best web design in Riverton, Ohio?"],
    ["best web design agency riverton", "What's the best web design agency in Riverton, Ohio?"],
    ["web design agencies in riverton", "What are the best web design agencies in Riverton, Ohio?"],
    ["web designers st. clair", "Who are the best web designers in St. Clair, Ohio?"],
    ["website designer fairview oh", "Who is the best website designer in Fairview, Ohio?"],
    ["st clair web design agency", "What's the best web design agency in St. Clair, Ohio?"],
    ["saint clair seo", "Who does the best seo in St. Clair, Ohio?"],
    ["web design services near riverton", "Who offers the best web design services in Riverton, Ohio?"],
    ["how to hire a web designer in riverton", "How do I hire a web designer in riverton?"],
    ["web design alvin", "What is the best web design alvin?"],
  ])("keywordToPrompt(%s) with places", (kw, prompt) => {
    expect(keywordToPrompt(kw, places)).toBe(prompt);
  });

  it("leaves keywords as before without places", () => {
    expect(keywordToPrompt("web design riverton")).toBe("What is the best web design riverton?");
  });

  it.each([
    ["seo services salem nh", "Who offers the best seo services salem nh?"],
    ["best seo services salem nh", "Who offers the best seo services salem nh?"],
    ["plumbers salem nh", "Who are the best plumbers salem nh?"],
    ["roofer salem", "Who is the best roofer salem?"],
    ["web design agencies salem nh", "What are the best web design agencies salem nh?"],
  ])("keywordToPrompt(%s) agrees with the thing asked about, not the town after it", (kw, prompt) => {
    expect(keywordToPrompt(kw)).toBe(prompt);
  });

  it("asks a project's keyword ideas about the towns it serves, or the city it tracks", () => {
    const salem = { servedTowns: null, cityName: "Salem, New Hampshire" };
    expect(keywordToPrompt("seo services salem nh", projectPlaces(salem))).toBe(
      "Who offers the best seo services in Salem, New Hampshire?",
    );
    expect(projectPlaces({ servedTowns: ["Windham, New Hampshire"], cityName: "Salem, New Hampshire" })).toEqual([
      "Windham, New Hampshire",
    ]);
    expect(projectPlaces({ servedTowns: [], cityName: null })).toEqual([]);
  });

  it.each([
    ["What's the best web design agency in Riverton, Ohio?", "best web design agency in riverton, ohio"],
    ["Who does the best web design in Riverton?", "best web design in riverton"],
    ["Who are the best web designers in St. Clair?", "best web designers in st. clair"],
  ])("promptToKeyword(%s)", (prompt, kw) => {
    expect(promptToKeyword(prompt)).toBe(kw);
  });
});
