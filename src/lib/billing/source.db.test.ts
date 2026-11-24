import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/** The ledger's `source`: work an AI agent started is recorded as "mcp", everything else as "app". */

vi.mock("server-only", () => ({}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { withBillingContext } = await import("./context");
const { recordLedgerAdjustment } = await import("@/lib/dataforseo/client");

describe.skipIf(!ready)("ledger source", () => {
  it("records mcp inside an agent's billing context and app outside it", async () => {
    const [ws] = await db.insert(s.workspaces).values({ name: `src-${randomUUID()}`, plan: "internal" }).returning();
    const adj = { workspaceId: ws.id, endpoint: "/v3/test", module: "local" as const, deltaUsd: 0.01 };
    await recordLedgerAdjustment(adj);
    await withBillingContext({ source: "mcp" }, () => recordLedgerAdjustment(adj));
    const rows = await db.select({ source: s.apiLedger.source }).from(s.apiLedger).where(eq(s.apiLedger.workspaceId, ws.id));
    expect(rows.map((r) => r.source).sort()).toEqual(["app", "mcp"]);
  });
});
