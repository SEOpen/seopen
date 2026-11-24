import { DrizzleQueryError } from "drizzle-orm";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/ui/data-table";

/** The Spend page on a stand-in database: the ledger reads come back empty and the jobs query can fail. */
const execute = vi.hoisted(() => ({ error: null as unknown, rows: [] as unknown[] }));

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => {
  const empty = () => {
    const query: Record<string, unknown> = { then: (done: (rows: unknown[]) => unknown) => done([]) };
    for (const step of ["from", "where", "groupBy", "orderBy", "limit"]) query[step] = () => query;
    return query;
  };
  return {
    db: {
      select: empty,
      execute: async () => {
        if (execute.error) throw execute.error;
        return execute.rows;
      },
    },
  };
});
vi.mock("@/app/actions/billing", () => ({ setOwnerCap: async () => {}, setPlatformCap: async () => {} }));
vi.mock("@/lib/admin/access", () => ({ requireAdmin: async () => ({ id: "owner" }) }));
vi.mock("@/lib/admin/overview", () => ({ dailyActivity: async () => [] }));
vi.mock("@/lib/billing/spend", () => ({ platformCapUsd: async () => 100 }));
vi.mock("@/lib/billing/usage", () => ({ platformMonthUsage: async () => ({ spentUsd: 0 }) }));
vi.mock("@/lib/dataforseo/client", () => ({ monthToDateSpendUsd: async () => 0, monthlyCapUsd: async () => 50 }));

const { default: AdminSpendPage } = await import("./page");

function tables(node: ReactNode, out: ReactElement<{ filename: string; rows: unknown[] }>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => tables(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (el.type === DataTable) out.push(el as unknown as ReactElement<{ filename: string; rows: unknown[] }>);
    tables(el.props.children, out);
  }
  return out;
}

const jobRows = async () => tables((await AdminSpendPage()) as ReactElement).find((t) => t.props.filename === "jobs")?.props.rows;
const queryError = (message: string, code: string) => new DrizzleQueryError("select ... from pgboss.job", [], Object.assign(new Error(message), { code }));

beforeEach(() => {
  execute.error = null;
  execute.rows = [];
});

describe("/admin/spend background jobs", () => {
  it("shows the jobs it reads", async () => {
    execute.rows = [{ name: "rank-daily", state: "completed", n: 3, last: "2026-11-09 10:00:00+00" }];
    expect(await jobRows()).toEqual(execute.rows);
  });

  it("shows no jobs when pgboss.job doesn't exist yet", async () => {
    execute.error = queryError('relation "pgboss.job" does not exist', "42P01");
    expect(await jobRows()).toEqual([]);
  });

  it("lets any other query failure surface instead of showing no jobs", async () => {
    execute.error = queryError("canceling statement due to statement timeout", "57014");
    await expect(AdminSpendPage()).rejects.toThrow(DrizzleQueryError);
  });

  it("lets a connection failure surface", async () => {
    execute.error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    await expect(AdminSpendPage()).rejects.toThrow("ECONNREFUSED");
  });
});
