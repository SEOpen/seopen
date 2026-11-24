import { handleMcp, methodNotAllowed } from "@/lib/mcp/handler";

/**
 * SEOpen's MCP server for AI agents. Stateless: POST only, so GET (a 2025
 * notification stream) and DELETE (ending a session) have nothing to do. proxy.ts lets this path
 * through without a session cookie; the handler checks the bearer key itself.
 */
export function POST(request: Request) {
  return handleMcp(request);
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
