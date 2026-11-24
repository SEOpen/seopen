import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { signup } from "@/public-signup/server";

const betterAuth = toNextJsHandler(auth);

export const { GET } = betterAuth;

/** Every POST goes to Better Auth as it is, unless a hosted service's sign-up answers it first (src/lib/public-signup/types.ts). */
export async function POST(request: Request): Promise<Response> {
  return (await signup.guard(request)) ?? betterAuth.POST(request);
}
