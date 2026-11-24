"use server";

import { refresh } from "next/cache";
import { requireSession } from "@/lib/auth/session";
import { requireProject } from "@/lib/projects";
import { setAlertRuleOp } from "./ops";

/** The Alerts page's on and off buttons. The op checks the rule; the page only offers real ones. */
export async function setAlertRule(projectId: number, rule: string, enabled: boolean) {
  const user = await requireSession();
  const { scope } = await requireProject(projectId);
  await setAlertRuleOp(scope, { userId: user.id, source: "app" }, { rule, enabled });
  refresh();
}
