import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { connection } from "next/server";
import { auth } from "@/lib/auth";

/**
 * Authorization server metadata (RFC 8414). The issuer is the app's origin, so clients look for it
 * here, at the root, rather than under Better Auth's `/api/auth`. It lists where to register, sign
 * in and swap codes for tokens, all under `/api/auth/oauth2/`.
 */
const metadata = oauthProviderAuthServerMetadata(auth, { headers: { "Access-Control-Allow-Origin": "*" } });

export async function GET(request: Request) {
  // Built per request from the running config, never at build time.
  await connection();
  return metadata(request);
}
