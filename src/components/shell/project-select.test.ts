import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("@/app/actions/projects", () => ({ selectProject: vi.fn(async (id: number) => void calls.push(`select ${id}`)) }));
// What the switcher needs from the rest of the app is the run param, not the sidebar around it.
vi.mock("@/modules/audit/score", () => ({ scoreBand: () => ({ tone: "good" }) }));

const { selectOnThisPage } = await import("./project-select");
const replace = (href: string) => void calls.push(`replace ${href}`);
const at = (href: string) => vi.stubGlobal("window", { location: { href } });

describe("selectOnThisPage", () => {
  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("takes ?run=1 off the address before selecting, so the new project can't spend on it", async () => {
    at("https://app.test/keywords?q=shoes&loc=2840&run=1");
    await selectOnThisPage(7, replace);
    expect(calls).toEqual(["replace /keywords?q=shoes&loc=2840", "select 7"]);
  });

  it("does the same on the other pages that spend on GET", async () => {
    at("https://app.test/backlinks?q=a.com&run=1");
    await selectOnThisPage(7, replace);
    at("https://app.test/domains?q=a.com&loc=2840&run=1");
    await selectOnThisPage(8, replace);
    expect(calls).toEqual(["replace /backlinks?q=a.com", "select 7", "replace /domains?q=a.com&loc=2840", "select 8"]);
  });

  it("leaves any other address alone", async () => {
    at("https://app.test/keywords?q=shoes&loc=2840");
    await selectOnThisPage(7, replace);
    expect(calls).toEqual(["select 7"]);
  });
});
