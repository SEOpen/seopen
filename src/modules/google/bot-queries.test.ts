import { describe, expect, it } from "vitest";
import { isLikelyBotQuery } from "./bot-queries";

describe("isLikelyBotQuery", () => {
  it("flags a number of four or more digits, a colon and a space before the search, as rank trackers send them", () => {
    expect(isLikelyBotQuery("5196: daily keyword rank tracking")).toBe(true);
    expect(isLikelyBotQuery("18763: google rank tracker online")).toBe(true);
    expect(isLikelyBotQuery("29403: segmentation and seo")).toBe(true);
  });

  it("leaves real searches alone, numbers and colons included", () => {
    expect(isLikelyBotQuery("daily keyword rank tracking")).toBe(false);
    expect(isLikelyBotQuery("5196 daily keyword rank tracking")).toBe(false);
    expect(isLikelyBotQuery("10:30 am pst to est")).toBe(false);
    expect(isLikelyBotQuery("john 3:16")).toBe(false);
    expect(isLikelyBotQuery("5196:")).toBe(false);
    expect(isLikelyBotQuery("5196:  two spaces")).toBe(false);
  });

  it("leaves short numbers alone, since people type those", () => {
    expect(isLikelyBotQuery("404: page not found meaning")).toBe(false);
    expect(isLikelyBotQuery("1: seo")).toBe(false);
  });

  it("flags three digits and a colon before a search about ranking", () => {
    expect(isLikelyBotQuery("327: google online rank tracker")).toBe(true);
    expect(isLikelyBotQuery("336: google rank tracker")).toBe(true);
    expect(isLikelyBotQuery("336: keyword ranking checker")).toBe(true);
    expect(isLikelyBotQuery("404: page not found meaning")).toBe(false);
    expect(isLikelyBotQuery("336 google rank tracker")).toBe(false);
    expect(isLikelyBotQuery("33: google rank tracker")).toBe(false);
  });

  it("flags a pasted spreadsheet row", () => {
    expect(isLikelyBotQuery('vacuform,7,70,i,"images, knowledge panel, ai overview, related searches",6,0.44,0.85')).toBe(true);
    expect(isLikelyBotQuery("seo tools,1200,45,0.8,commercial")).toBe(true);
  });

  it("leaves numbers with commas alone, as people type them", () => {
    expect(isLikelyBotQuery("1,000,000")).toBe(false);
    expect(isLikelyBotQuery("how much is 1,000,000,000 in words")).toBe(false);
    expect(isLikelyBotQuery("genesis 1,2,3")).toBe(false);
    expect(isLikelyBotQuery("apples, pears, 2 plums")).toBe(false);
    expect(isLikelyBotQuery("seo, sem, 4.5 stars, reviews")).toBe(false);
  });

  // The rule's known miss: a person who types four digits and a colon first, such as a year.
  it("also flags a real search in that shape", () => {
    expect(isLikelyBotQuery("2024: best seo tools")).toBe(true);
  });

  it("flags a rank tracker's keyword, a comma, then a town and state code", () => {
    expect(isLikelyBotQuery("website page optimization, derry nh")).toBe(true);
    expect(isLikelyBotQuery("website design services, derry nh")).toBe(true);
    expect(isLikelyBotQuery("plumbing repair, north salem nh")).toBe(true);
  });

  it("leaves a town, a comma and its state alone, as people write it", () => {
    expect(isLikelyBotQuery("how much does seo cost in salem, nh")).toBe(false);
    expect(isLikelyBotQuery("best web design company in salem, nh")).toBe(false);
    expect(isLikelyBotQuery("dental seo salem, nh")).toBe(false);
    expect(isLikelyBotQuery("hampton beach, new hampshire contractor website design")).toBe(false);
    expect(isLikelyBotQuery("salem, nh web design")).toBe(false);
  });

  it("flags an AI prompt tracker's prompt that says where it is", () => {
    expect(isLikelyBotQuery("web development salem nh. my location is salem, new hampshire, united states, usa.")).toBe(true);
    expect(isLikelyBotQuery("my location is not showing on google maps")).toBe(false);
  });
});
