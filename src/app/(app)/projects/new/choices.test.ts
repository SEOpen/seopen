import { describe, expect, it } from "vitest";
import { rules } from "@/plan-policy/rules";
import { newProjectChoices, newProjectDescription } from "./choices";

describe("the new project form's buttons", () => {
  it("offers the guided setup on a paid plan, as before", () => {
    const paid = newProjectChoices(false, 500);
    expect(paid.next).toEqual({ label: "Create and suggest a setup", value: "setup" });
    expect(paid.submitLabel).toBe("Just create it");
    expect(paid.hint).toMatch(rules.hasPlans ? /the few research credits it uses are included in your plan/ : /its lookups cost a few cents of DataForSEO/);
    if (!rules.hasPlans) expect(paid.hint).not.toMatch(/credit|plan/);
    // Setup reads no Google data, and the privacy page promises Google data never goes to DataForSEO.
    expect(paid.hint).not.toMatch(/Google data/);
    expect(paid.hint).toMatch(/doesn't read your Search Console or Analytics/);
  });

  it("doesn't offer the setup on Free, where it would only create the project, or promise credits Free doesn't have", () => {
    const free = newProjectChoices(true, 100);
    expect(free.next?.value).not.toBe("setup");
    expect(JSON.stringify(free)).not.toMatch(/suggest a setup|research credits|included in your plan/i);
  });

  it("leads on Free with the one thing Free can run, and says it starts the audit", () => {
    const free = newProjectChoices(true, 100);
    expect(free.next).toEqual({ label: "Create and audit", value: "audit" });
    expect(free.submitLabel).toBe("Just create it");
    expect(free.hint).toMatch(/up to 100 pages/);
    expect(free.hint).toMatch(/Just create it .*without starting anything/);
  });

  it("doesn't offer an audit that can't start now, and says why instead", () => {
    const why = "The Free plan includes one site audit a week, and this week's has been used.";
    const free = newProjectChoices(true, 100, why);
    expect(free.next).toBeNull();
    expect(free.submitLabel).toBe("Create project");
    expect(free.hint).toContain(why);
  });
});

describe("the new project page's header line", () => {
  it("names Plausible and Umami only on a workspace where they're open", () => {
    expect(newProjectDescription({ plan: "internal" })).toMatch(/Analytics: Google Analytics, PostHog, Plausible or Umami\.$/);
    for (const plan of ["free", "trial", "starter", "pro"]) {
      const line = newProjectDescription({ plan });
      expect(line, plan).toMatch(/Analytics: Google Analytics or PostHog\.$/);
      expect(line, plan).not.toMatch(/Plausible|Umami/);
    }
  });
});
