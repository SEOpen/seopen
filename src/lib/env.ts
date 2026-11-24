import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SEOPEN_SECRET_KEY: z.string().min(40, "SEOPEN_SECRET_KEY must be 32 random bytes, base64"),
  DATAFORSEO_LOGIN: z.string().default(""),
  DATAFORSEO_PASSWORD: z.string().default(""),
  DATAFORSEO_MONTHLY_CAP_USD: z.coerce.number().positive().default(75),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REDIRECT_URI: z.string().default("http://127.0.0.1:4100/api/google/callback"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
