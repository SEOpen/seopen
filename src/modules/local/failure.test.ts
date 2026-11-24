import { describe, expect, it, vi } from "vitest";
import { localFailure, projectLocalFailure } from "./failure";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-11-07T12:00:00Z");
const at = new Date("2026-11-07T11:30:00Z");

describe("localFailure", () => {
  it("points at the business's own page", () => {
    const f = localFailure({ status: "failed", error: null, createdAt: at, finishedAt: at }, 7, "UTC", NOW);
    expect(f).toMatchObject({ reason: "None of this check's map searches came back.", retry: true, next: { href: "/local/7" } });
  });

  it("keeps SEOpen's own reason and drops the vendor's", () => {
    expect(localFailure({ status: "failed", error: "Could not queue the check", createdAt: at }, 7, "UTC", NOW)?.reason).toBe("Could not queue the check.");
    expect(localFailure({ status: "failed", error: "40501 Invalid Field", createdAt: at }, 7, "UTC", NOW)?.reason).toBe("The map search service rejected this check, so running it again won't help. Check this business's keywords.");
    expect(localFailure({ status: "failed", error: "40501 Invalid Field", createdAt: at }, 7, "UTC", NOW)).toMatchObject({ retry: false, next: { label: "View", href: "/local/7" } });
  });

  it("calls a check stuck posting past the hour one that didn't start, and all of them only if all are", () => {
    const old = new Date(NOW.getTime() - 61 * 60_000);
    const stuck = localFailure({ status: "posting", error: null, createdAt: old }, 1, "UTC", NOW)!;
    const failed = localFailure({ status: "failed", error: null, createdAt: at }, 2, "UTC", NOW)!;
    expect(stuck).toMatchObject({ stuck: true, reason: "This check didn't start.", retry: true });
    expect(projectLocalFailure([stuck, stuck])).toMatchObject({ stuck: true, reason: "The latest checks didn't start for 2 businesses." });
    expect(projectLocalFailure([stuck, failed])?.stuck).toBeFalsy();
  });

  it("is nothing while running, after a success, and for a young posting row", () => {
    for (const status of ["pending", "posting", "done"]) expect(localFailure({ status, error: null, createdAt: at }, 7, "UTC", NOW)).toBeNull();
    expect(localFailure(undefined, 7, "UTC", NOW)).toBeNull();
  });

  it("makes several businesses one source on a project, on their newest day", () => {
    const one = localFailure({ status: "failed", error: null, createdAt: new Date("2026-11-05T10:00:00Z") }, 1, "UTC", NOW)!;
    const two = localFailure({ status: "failed", error: null, createdAt: at }, 2, "UTC", NOW)!;
    expect(projectLocalFailure([one])).toBe(one);
    expect(projectLocalFailure([one, two])).toMatchObject({ day: "Nov 7", reason: "The latest checks failed for 2 businesses.", next: { href: "/local" } });
  });
});
