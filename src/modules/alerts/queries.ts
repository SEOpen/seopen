import { and, count, desc, eq, gte, isNotNull, isNull, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { alerts, alertSends } from "@/db/schema";
import type { ProjectScope } from "@/lib/workspace";
import { isAlertRule, RULES } from "./rules";

export type AlertStatus = "open" | "resolved" | "all";

export interface AlertRow {
  id: number;
  rule: string;
  ruleLabel: string;
  urgent: boolean;
  title: string;
  detail: string | null;
  source: string;
  screen: string;
  detectedAt: Date;
  resolvedAt: Date | null;
  /** When its email went, or null: not sent yet, or nobody to send it to. */
  emailedAt: Date | null;
}

const where = (scope: ProjectScope, ...more: (SQL | undefined)[]) => and(eq(alerts.workspaceId, scope.workspaceId), eq(alerts.projectId, scope.projectId), ...more);

const statusFilter = (status: AlertStatus) => (status === "open" ? isNull(alerts.resolvedAt) : status === "resolved" ? isNotNull(alerts.resolvedAt) : undefined);

/** A project's alerts, newest first. */
export async function listAlerts(scope: ProjectScope, o: { status?: AlertStatus; limit?: number; since?: Date } = {}): Promise<AlertRow[]> {
  const rows = await db
    .select({
      id: alerts.id,
      rule: alerts.rule,
      title: alerts.title,
      detail: alerts.detail,
      source: alerts.source,
      screen: alerts.screen,
      detectedAt: alerts.detectedAt,
      resolvedAt: alerts.resolvedAt,
      emailedAt: alertSends.sentAt,
    })
    .from(alerts)
    .leftJoin(alertSends, eq(alertSends.id, alerts.sendId))
    .where(where(scope, statusFilter(o.status ?? "all"), o.since ? gte(alerts.detectedAt, o.since) : undefined))
    .orderBy(desc(alerts.detectedAt), desc(alerts.id))
    .limit(o.limit ?? 100);
  return rows.map((r) => ({
    ...r,
    ruleLabel: isAlertRule(r.rule) ? RULES[r.rule].label : r.rule,
    urgent: isAlertRule(r.rule) && RULES[r.rule].urgent,
  }));
}

/** Open and all-time counts, for headings. */
export async function alertCounts(scope: ProjectScope): Promise<{ open: number; total: number }> {
  const [[open], [total]] = await Promise.all([
    db.select({ n: count() }).from(alerts).where(where(scope, isNull(alerts.resolvedAt))),
    db.select({ n: count() }).from(alerts).where(where(scope)),
  ]);
  return { open: open?.n ?? 0, total: total?.n ?? 0 };
}

/** One alert in the project, for its link. */
export async function getAlert(scope: ProjectScope, id: number) {
  const [row] = await db.select({ id: alerts.id, screen: alerts.screen }).from(alerts).where(where(scope, eq(alerts.id, id)));
  return row ?? null;
}
