import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The tests run against a real D1 in workerd with the same SQL migrations a deploy applies.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SETUP_TOKEN: "test-setup-token-0123456789abcdef0123456789",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
