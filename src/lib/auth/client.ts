"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

/**
 * `oauthProviderClient` sends the signed OAuth request on the sign-in and consent pages' address
 * along with signing in or answering, so the provider picks the MCP connection up where it left off
 * (src/lib/auth/oauth.ts). On any other page there is nothing to send.
 */
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
