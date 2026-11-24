import { describe, expect, it } from "vitest";
import {
  accountsFigure,
  ceilingCaption,
  columnsWithData,
  healthFigures,
  healthSentence,
  overviewSentence,
  spendFigures,
  spendSentence,
  usersSentence,
  workspaceSentence,
  workspacesSentence,
  type DailyMeasure,
  type DayTotals,
  type HealthCounts,
  type UserCounts,
  type WorkspaceCounts,
  type WorkspaceStanding,
} from "./brief";
import { rules } from "@/plan-policy/rules";

const day = (i: number) => `2026-11-${String(i + 1).padStart(2, "0")}`;

/** Fourteen days: the first seven hold the "before" totals on their last day, the last seven the "now" totals. */
function fortnight(before: Partial<DayTotals>, now: Partial<DayTotals>): DayTotals[] {
  return Array.from({ length: 14 }, (_, i) => ({
    date: day(i),
    accounts: 0,
    spendUsd: 0,
    ...(i === 6 ? before : i === 13 ? now : {}),
  }));
}

/** A daily count a plan adds, on the same two days as `fortnight`. */
const projects = (before: number, now: number): DailyMeasure => ({ noun: "new project", byDate: { [day(6)]: before, [day(13)]: now } });

const CLEAR: HealthCounts = { failed: 0, syncs: 0, connections: 0, paused: 0, spend: 0, billing: 0 };

describe("overviewSentence", () => {
  it("is calm when nothing happened", () => {
    expect(overviewSentence(fortnight({}, {}), 0)).toBe("No new accounts in the last 14 days.");
    expect(overviewSentence(fortnight({}, {}), 0, [projects(0, 0)])).toBe("No new accounts or new projects in the last 14 days.");
  });

  it("says every measure against the week before", () => {
    expect(overviewSentence(fortnight({ accounts: 1 }, { accounts: 2 }), 0, [projects(3, 5)])).toBe("Two new accounts and five new projects in the last 7 days, against one and three in the 7 days before.");
  });

  it("leaves out a measure with nothing on either side", () => {
    expect(overviewSentence(fortnight({}, {}), 0, [projects(3, 5)])).toBe("Five new projects in the last 7 days, against three in the 7 days before.");
  });

  it("says none when one side is empty", () => {
    expect(overviewSentence(fortnight({ accounts: 2 }, {}), 0)).toBe("No new accounts in the last 7 days, against two in the 7 days before.");
    expect(overviewSentence(fortnight({}, { accounts: 1 }), 0, [projects(4, 4)])).toBe("One new account and four new projects in the last 7 days, against none and four in the 7 days before.");
  });

  it("doesn't call equal weeks a change", () => {
    expect(overviewSentence(fortnight({ accounts: 2 }, { accounts: 2 }), 0)).toBe("Two new accounts in the last 7 days, the same as the 7 days before.");
  });

  it("adds what Health has open", () => {
    expect(overviewSentence(fortnight({}, {}), 1)).toBe("No new accounts in the last 14 days. Health has one problem open.");
    expect(overviewSentence(fortnight({}, {}), 12)).toBe("No new accounts in the last 14 days. Health has 12 problems open.");
  });

  it("only counts the two windows, not older days", () => {
    const older = [{ date: "2026-10-01", accounts: 100, spendUsd: 100 }];
    expect(overviewSentence([...older, ...fortnight({}, {})], 0, [{ noun: "new project", byDate: { "2026-10-01": 100 } }])).toBe("No new accounts or new projects in the last 14 days.");
  });
});

describe("accountsFigure", () => {
  const days = fortnight({ accounts: 1 }, { accounts: 3 });

  it("shows the week's new accounts as the change", () => {
    expect(accountsFigure(40, days)).toMatchObject({ state: "value", value: "40", caption: "in the last 7 days", delta: { text: "+3", tone: "good", up: true } });
  });

  it("counts the same week as the sentence above it", () => {
    expect(overviewSentence(days, 0)).toBe("Three new accounts in the last 7 days, against one in the 7 days before.");
    expect(accountsFigure(40, days)).toMatchObject({ delta: { text: "+3" } });
  });

  it("says none rather than showing a zero change", () => {
    expect(accountsFigure(40, fortnight({ accounts: 2 }, {}))).toMatchObject({ delta: null, caption: "none new in the last 7 days" });
  });
});

describe("healthSentence", () => {
  it("is calm when every list is empty", () => {
    expect(healthSentence(CLEAR)).toBe("Nothing needs a look. No jobs failed in the last 7 days, and no workspace has an open problem.");
  });

  it("agrees with one problem", () => {
    expect(healthSentence({ ...CLEAR, failed: 1 })).toBe("One failed job in the last 7 days needs a look.");
  });

  it("agrees with several of one kind", () => {
    expect(healthSentence({ ...CLEAR, paused: 2 })).toBe("Two paused jobs need a look.");
  });

  it("lists every kind that has something", () => {
    expect(healthSentence({ failed: 3, syncs: 1, connections: 1, paused: 2, spend: 1, billing: 1 })).toBe(
      "Three failed jobs in the last 7 days, one sync problem, one broken connection, two paused jobs, one workspace over a spend alert or near a ceiling and one billing problem need a look.",
    );
    expect(healthSentence({ ...CLEAR, spend: 2, billing: 1 })).toBe("Two workspaces over a spend alert or near a ceiling and one billing problem need a look.");
    expect(healthSentence({ ...CLEAR, billing: 2, billingNoun: "suspended workspace" })).toBe("Two suspended workspaces need a look.");
  });

  it("puts a DataForSEO balance problem first", () => {
    expect(healthSentence({ ...CLEAR, balance: 1 })).toBe("One DataForSEO balance problem needs a look.");
    expect(healthSentence({ ...CLEAR, balance: 2, failed: 9 })).toBe("Two DataForSEO balance problems and nine failed jobs in the last 7 days need a look.");
  });

  it("puts a worker problem before everything", () => {
    expect(healthSentence({ ...CLEAR, worker: 1 })).toBe("One worker problem needs a look.");
    expect(healthSentence({ ...CLEAR, worker: 1, balance: 1, failed: 2 })).toBe("One worker problem, one DataForSEO balance problem and two failed jobs in the last 7 days need a look.");
  });
});

describe("healthFigures", () => {
  it("adds spend and billing together", () => {
    const figures = healthFigures({ failed: 4, syncs: 1, connections: 9, paused: 2, spend: 3, billing: 1 });
    expect(figures.map((f) => (f.state === "value" ? f.value : null))).toEqual(["4", "1", "2", "4"]);
  });

  it("names the spend figure as the plan policy says", () => {
    expect(healthFigures({ ...CLEAR, moneyLabel: "Spend and suspended" }).find((f) => f.id === "money")).toMatchObject({ label: "Spend and suspended" });
  });

  it("counts a DataForSEO balance problem with spend and billing", () => {
    const figures = healthFigures({ failed: 0, syncs: 0, connections: 0, paused: 0, spend: 0, billing: 0, balance: 1 });
    expect(figures.find((f) => f.id === "money")).toMatchObject({ value: "1" });
  });
});

describe("spendSentence", () => {
  it("is calm with no spend", () => {
    expect(spendSentence(fortnight({}, {}), 0, 25)).toBe("No DataForSEO spend across any workspace in the last 14 days. The owner workspace has used $0.00 of its $25 cap this month.");
  });

  it("sets the week against the one before", () => {
    expect(spendSentence(fortnight({ spendUsd: 3.1 }, { spendUsd: 4.2 }), 8.54, 25)).toBe("DataForSEO spend was $4.20 across every workspace in the last 7 days, against $3.10 in the 7 days before. The owner workspace has used $8.54 of its $25 cap this month.");
  });

  it("doesn't call a change under a cent a change", () => {
    expect(spendSentence(fortnight({ spendUsd: 3.101 }, { spendUsd: 3.102 }), 1, 25)).toContain("$3.10 across every workspace in the last 7 days, the same as the 7 days before.");
  });

  it("says when the owner workspace has hit its cap", () => {
    expect(spendSentence(fortnight({}, {}), 25, 25)).toContain("The owner workspace is at its $25 cap, so its paid calls have stopped.");
  });
});

describe("spendFigures", () => {
  const modules = [
    { module: "rank", cost: 1.5, calls: 10 },
    { module: "keywords", cost: 4, calls: 3 },
  ];

  it("leads with spend against the cap and the costliest module", () => {
    const figures = spendFigures(5.5, 25, modules);
    expect(figures[0]).toMatchObject({ value: "$5.50", caption: "of $25 cap" });
    expect(figures[1]).toMatchObject({ value: "$19.50" });
    expect(figures[2]).toMatchObject({ value: "13" });
    expect(figures[3]).toMatchObject({ value: "keywords", caption: "$4.00 this month" });
  });

  it("leaves the caller's list in its order", () => {
    const list = [...modules];
    spendFigures(5.5, 25, list);
    expect(list[0].module).toBe("rank");
  });

  it("never shows less than nothing remaining", () => {
    expect(spendFigures(30, 25, modules)[1]).toMatchObject({ value: "$0.00" });
  });

  it("explains an empty month", () => {
    expect(spendFigures(0, 25, [])[3]).toMatchObject({ state: "empty", text: "No paid calls this month." });
  });
});

describe("usersSentence", () => {
  const counts: UserCounts = { accounts: 40, newThisWeek: 3, seenThisWeek: 12, unverified: 0 };

  it("says who signed up and who was seen", () => {
    expect(usersSentence(counts)).toBe("Three new accounts in the last 7 days, and 12 of 40 accounts were seen in that time.");
  });

  it("is calm with nobody new", () => {
    expect(usersSentence({ ...counts, newThisWeek: 0 })).toBe("No new accounts in the last 7 days, and 12 of 40 accounts were seen in that time.");
  });

  it("agrees with one", () => {
    expect(usersSentence({ ...counts, newThisWeek: 1, seenThisWeek: 1, unverified: 1 })).toBe("One new account in the last 7 days, and one of 40 accounts was seen in that time. One account hasn't verified its email.");
  });

  it("says who hasn't verified, and nothing when everyone has", () => {
    expect(usersSentence({ ...counts, unverified: 5 })).toContain("Five accounts haven't verified their email.");
    expect(usersSentence(counts)).not.toContain("verified");
  });

  it("says all and none rather than 40 of 40 or 0 of 40", () => {
    expect(usersSentence({ ...counts, seenThisWeek: 40 })).toContain("all 40 accounts were seen in that time");
    expect(usersSentence({ ...counts, seenThisWeek: 0 })).toContain("no account was seen in that time");
    expect(usersSentence({ accounts: 1, newThisWeek: 0, seenThisWeek: 1, unverified: 0 })).toContain("the only account was seen in that time");
  });

  it("says so with no accounts", () => {
    expect(usersSentence({ accounts: 0, newThisWeek: 0, seenThisWeek: 0, unverified: 0 })).toBe("There are no accounts yet.");
  });
});

describe("workspacesSentence", () => {
  // Kinds come from the plan policy; these are made up.
  const counts: WorkspaceCounts = { total: 40, kinds: ["two in teams", "five solo"], suspended: 0, alerts: 0, spentUsd: 12.3, capUsd: 100 };

  it("says the mix, the bill and the alerts", () => {
    expect(workspacesSentence(counts)).toBe("There are 40 workspaces: two in teams and five solo. DataForSEO spend is $12.30 of the $100 platform cap this month. No workspace is over a spend alert.");
  });

  it("adds suspended only when there are some", () => {
    expect(workspacesSentence({ ...counts, suspended: 1 })).toContain("two in teams, five solo and one suspended.");
  });

  it("agrees with one workspace", () => {
    expect(workspacesSentence({ ...counts, total: 1, kinds: ["none in teams"] })).toContain("There is one workspace: none in teams.");
  });

  it("says just the count without kinds", () => {
    expect(workspacesSentence({ ...counts, kinds: [] })).toContain("There are 40 workspaces. DataForSEO");
    expect(workspacesSentence({ ...counts, kinds: [], suspended: 2 })).toContain("There are 40 workspaces: two suspended. DataForSEO");
  });

  it("says when the platform cap has stopped paid calls", () => {
    expect(workspacesSentence({ ...counts, spentUsd: 100 })).toContain("DataForSEO spend has reached the $100 platform cap, so paid calls have stopped.");
  });

  it("counts spend alerts and agrees with them", () => {
    expect(workspacesSentence({ ...counts, alerts: 1 })).toContain("One workspace is over a spend alert.");
    expect(workspacesSentence({ ...counts, alerts: 2 })).toContain("Two workspaces are over a spend alert.");
  });
});

describe("workspaceSentence", () => {
  const CALM = { failed: 0, syncs: 0, connections: 0, paused: 0, billing: 0 };
  const ws: WorkspaceStanding = { plan: "pro", suspended: false, spentUsd: 4.2, ceilingUsd: 37.4, problems: CALM };

  it.skipIf(!rules.hasPlans)("says the plan, the spend against the ceiling, and that all is well", () => {
    expect(workspaceSentence(ws)).toBe("This workspace is on the Pro plan and has spent $4.20 of its $37.40 ceiling this month. Nothing needs a look.");
  });

  it.skipIf(!rules.hasPlans)("says a trial as a trial", () => {
    expect(workspaceSentence({ ...ws, plan: "trial", ceilingUsd: 3, spentUsd: 1 })).toContain("This workspace is on a trial and has spent $1.00 of its $3.00 ceiling this month.");
  });

  it.skipIf(!rules.hasPlans)("leaves the ceiling out when there isn't one", () => {
    expect(workspaceSentence({ ...ws, ceilingUsd: Infinity })).toContain("This workspace is on the Pro plan and has spent $4.20 this month.");
    expect(ceilingCaption(Infinity)).toBe("no ceiling");
  });

  it("captions the figure with the ceiling it's given", () => {
    expect(ceilingCaption(37.4)).toBe("of $37.40 ceiling");
    expect(ceilingCaption(0)).toBe("of $0.00 ceiling");
  });

  it("says when the ceiling has stopped paid calls", () => {
    expect(workspaceSentence({ ...ws, spentUsd: 37.4 })).toContain("has reached its $37.40 ceiling, so its paid calls have stopped.");
  });

  it("says no plan stops paid calls, with what it spent only if it spent anything", () => {
    expect(workspaceSentence({ ...ws, plan: "none", ceilingUsd: 0, spentUsd: 0 })).toBe("This workspace has no plan, so its paid calls have stopped. Nothing needs a look.");
    expect(workspaceSentence({ ...ws, plan: "none", ceilingUsd: 0, spentUsd: 1 })).toContain("so its paid calls have stopped. It has spent $1.00 this month.");
  });

  it("puts suspended ahead of the plan", () => {
    expect(workspaceSentence({ ...ws, suspended: true })).toBe("This workspace is suspended, so its paid calls and jobs have stopped. It has spent $4.20 this month. Nothing needs a look.");
  });

  it("names every kind of problem, and can't read as all well with one", () => {
    expect(workspaceSentence({ ...ws, problems: { ...CALM, failed: 1 } })).toContain("One failed job in the last 7 days needs a look.");
    expect(workspaceSentence({ ...ws, problems: { failed: 3, syncs: 1, connections: 1, paused: 2, billing: 1 } })).toContain(
      "Three failed jobs in the last 7 days, one sync problem, one broken connection, two paused jobs and one billing problem need a look.",
    );
    expect(workspaceSentence({ ...ws, problems: { ...CALM, connections: 1 } })).not.toContain("Nothing");
  });
});

describe("columnsWithData", () => {
  const columns = [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }];

  it("drops a column that's empty in every row, whichever way it's empty", () => {
    const rows = [
      { a: "x", b: null, c: "", d: "–" },
      { a: "y", b: undefined, c: "", d: "–" },
    ];
    expect(columnsWithData(columns, rows).map((c) => c.key)).toEqual(["a"]);
  });

  it("keeps a column with one value, and treats zero as a value", () => {
    expect(columnsWithData(columns, [{ a: 0, b: null, c: "z", d: "–" }, { a: 0, b: "y" }]).map((c) => c.key)).toEqual(["a", "b", "c"]);
  });

  it("keeps every head when there are no rows", () => {
    expect(columnsWithData(columns, [])).toHaveLength(4);
  });
});
