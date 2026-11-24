import { db } from "@/db";
import { alertRules } from "@/db/schema";
import { OpError, type Actor, type OpOptions } from "@/lib/ops";
import type { ProjectScope } from "@/lib/workspace";
import { ruleStates } from "./record";
import { isAlertRule, RULES, type AlertRule } from "./rules";

export interface RuleChange {
  rule: AlertRule;
  label: string;
  enabled: boolean;
  /** False when the rule was already that way. */
  changed: boolean;
  message: string;
}

/**
 * Turns one alert rule on or off for a project: the Alerts page and the MCP update_alert_rule tool.
 * Turning a rule off stops new alerts and keeps the history; alerts already open stay listed.
 */
export async function setAlertRuleOp(scope: ProjectScope, _actor: Actor, input: { rule: unknown; enabled: boolean }, opts: OpOptions = {}): Promise<RuleChange> {
  if (!isAlertRule(input.rule)) throw new OpError(`There's no alert rule called “${String(input.rule)}”.`);
  const rule = input.rule;
  const was = (await ruleStates(scope)).find((r) => r.rule === rule)?.enabled ?? true;
  const { label } = RULES[rule];
  const changed = was !== input.enabled;
  const state = input.enabled ? "on" : "off";
  if (!opts.dryRun && changed) {
    await db
      .insert(alertRules)
      .values({ ...scope, rule, enabled: input.enabled })
      .onConflictDoUpdate({ target: [alertRules.projectId, alertRules.rule], set: { enabled: input.enabled, updatedAt: new Date() } });
  }
  const message = !changed
    ? `“${label}” is already ${state}.`
    : opts.dryRun
      ? `Would turn “${label}” ${state}.${input.enabled ? "" : " Alerts already found stay in the history."}`
      : `Turned “${label}” ${state}.`;
  return { rule, label, enabled: input.enabled, changed, message };
}
