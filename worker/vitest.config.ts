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
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // @simplewebauthn/server and its @peculiar/asn1-* packages are about 240 small modules, and
    // each test file's runner transformed them all. Pre-bundled once, the suite takes about half
    // the time.
    // Hono stays unbundled: bundling "hono" apart from "hono/route" splits its internal symbols.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["@simplewebauthn/server", "@simplewebauthn/server/helpers"],
        },
      },
    },
  },
});
