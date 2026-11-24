"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { requireSession } from "@/lib/auth/session";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { deleteTeardown } from "./teardowns";

const idInput = z.number().int().positive();

/** Deletes one of the current project's saved teardowns, then goes back to the list. */
export async function deleteTeardownAction(id: number): Promise<ActionResult> {
  await requireSession();
  const teardownId = idInput.parse(id);
  const project = await getCurrentProject();
  if (!project) throw new Error("Create a project first: teardowns belong to a project.");
  const scope = projectScope(project);
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  await deleteTeardown(scope, teardownId);
  redirect("/domains/teardowns");
}
