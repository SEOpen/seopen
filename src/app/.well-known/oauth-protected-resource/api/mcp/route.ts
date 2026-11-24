import { connection } from "next/server";
import { authBaseUrl } from "@/lib/auth";
import { protectedResourceMetadata } from "@/lib/auth/oauth";

/**
 * Protected resource metadata for `/api/mcp` (RFC 9728), the address the endpoint's 401 names. It
 * tells an MCP client that this app is the endpoint's authorization server and which scopes exist.
 */
export async function GET() {
  await connection();
  return Response.json(protectedResourceMetadata(authBaseUrl()), {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
}
