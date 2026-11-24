import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { summarize } from "@/app/(app)/project-summary";
import type { ModuleResult } from "@/app/(app)/dashboard-load";
import { DASHBOARD_MODULES } from "@/app/(app)/dashboard-modules";
import { dashboard } from "./dashboard";
import { fixtures } from "./dashboard.fixtures";

// The real modules' loaders import server-only code; only their pure parts run here.
vi.mock("server-only", () => ({}));

const { View, changes } = dashboard;
/** The card as read aloud. The arrow and "down" carry the sign, so the number itself has none. */
const card = (data: typeof fixtures.full) =>
  renderToStaticMarkup(<View data={{ ...data, series: [] }} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

/** The change All projects shows for backlinks. */
function allProjects(data: typeof fixtures.full) {
  const results = DASHBOARD_MODULES.map((module): ModuleResult => (module.id === "backlinks" ? { module, status: "ok", data } : { module, status: "empty" }));
  const figure = summarize(results).figures.find((f) => f.id === "backlinks")!;
  return figure.state === "value" ? figure.delta : null;
}

describe("backlinks card", () => {
  it("reads the same change as All projects", () => {
    expect(allProjects(fixtures.full)).toMatchObject({ text: "−1.6%", up: false });
    expect(card(fixtures.full)).toContain("Backlinks 18,942 down 1.6% (worse)");
    expect(card(fixtures.full)).not.toContain("311");
  });

  it("shows a small count as a plain difference, as All projects does", () => {
    const small = { ...fixtures.full, backlinks: 12, backlinksChange: -3 };
    expect(allProjects(small)).toMatchObject({ text: "−3" });
    expect(card(small)).toContain("Backlinks 12 down 3 (worse)");
  });

  it("has no change with nothing earlier", () => {
    expect(allProjects(fixtures.sparse)).toBeNull();
    expect(card(fixtures.sparse)).not.toMatch(/[▲▼]/);
  });

  it("gives What changed the same percentage", () => {
    expect(changes!(fixtures.full).find((c) => c?.label === "Backlinks")).toMatchObject({ unit: "percent", from: 19_253, to: 18_942 });
  });
});
