"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { disconnectApp } from "@/lib/mcp/oauth";
import { workspaceScope } from "@/lib/workspace/current";

/**
 * Disconnects an app the workspace connected over OAuth (src/lib/mcp/oauth.ts). Its next call to
 * the MCP server gets 401, and connecting it again means asking again.
 */
export async function disconnectAppAction(formData: FormData) {
  await requireSession();
  const id = z.string().min(1).max(200).parse(formData.get("id"));
  await disconnectApp(await workspaceScope(), id);
  refresh();
}
