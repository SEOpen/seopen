import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { adminExtraFile, adminSpendExtraFile } from "./src/components/shell/admin-extra-file";
import { planPolicyFile, PLAN_POLICY_PARTS } from "./src/lib/billing/policy-file";
import { billingProviderFile } from "./src/lib/billing/provider-file";
import { PUBLIC_SIGNUP_PARTS, publicSignupFile } from "./src/lib/public-signup/file";
import { testDatabaseName } from "./src/db/test-database";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // The billing provider, the plan policy, public sign-up and Admin extras first, so "@" doesn't take
    // them (src/lib/billing/provider.ts, src/lib/billing/policy.ts, src/lib/public-signup/file.ts).
    alias: [
      ...PLAN_POLICY_PARTS.map((part) => ({ find: new RegExp(`^@/plan-policy/${part}$`), replacement: fileURLToPath(new URL(planPolicyFile(root, part), import.meta.url)) })),
      ...PUBLIC_SIGNUP_PARTS.map((part) => ({ find: new RegExp(`^@/public-signup/${part}$`), replacement: fileURLToPath(new URL(publicSignupFile(root, part), import.meta.url)) })),
      { find: /^@\/billing-provider$/, replacement: fileURLToPath(new URL(billingProviderFile(root), import.meta.url)) },
      { find: /^@\/admin-extra$/, replacement: fileURLToPath(new URL(adminExtraFile(root), import.meta.url)) },
      { find: /^@\/admin-spend-extra$/, replacement: fileURLToPath(new URL(adminSpendExtraFile(root), import.meta.url)) },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", ".claude/**", ".next/**", "infra/**"],
    // Empty keys, so nothing in the suite can reach Resend or Anthropic even if the shell has real ones.
    // Each git worktree gets its own test database (src/db/test-database.ts).
    env: { DATABASE_URL: `postgres://localhost:5432/${testDatabaseName(root)}`, RESEND_API_KEY: "", ANTHROPIC_API_KEY: "" },
    globalSetup: ["./src/db/test-global-setup.ts"],
  },
});
