"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { track } from "@/lib/analytics/server";
import { requireSession } from "@/lib/auth/session";
import { createApiKey, MAX_KEY_NAME, revokeApiKey } from "@/lib/mcp/keys";
import { workspaceScope } from "@/lib/workspace/current";

export type CreateKeyState = { ok: true; key: string; name: string } | { ok: false; message: string } | null;

/**
 * Makes an API key for the MCP server. The key goes back to the form once and
 * is never readable again; only its hash is stored.
 */
export async function createApiKeyAction(_prev: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const user = await requireSession();
  const name = z.string().trim().min(1).max(MAX_KEY_NAME).safeParse(formData.get("name"));
  if (!name.success) return { ok: false, message: `Give the key a name of up to ${MAX_KEY_NAME} characters.` };
  const { workspaceId } = await workspaceScope();
  const write = formData.get("write") === "on";
  const research = formData.get("research") === "on";
  const { key } = await createApiKey({ workspaceId, userId: user.id }, { name: name.data, write, research });
  track(user.id, "api_key_created", { write, research }, { workspaceId });
  refresh();
  return { ok: true, key, name: name.data };
}

/** Revokes one of the current workspace's keys. Agents using it get 401 from the next call. */
export async function revokeApiKeyAction(formData: FormData) {
  await requireSession();
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  await revokeApiKey(await workspaceScope(), id);
  refresh();
}
