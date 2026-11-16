import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { generateVapidKeys } from "@mmmike/web-push/vapid";
import { defineConfig } from "vitest/config";

// The tests run against a real D1 in workerd with the same SQL migrations a deploy applies.
const migrations = await readD1Migrations("./migrations");
// A fresh VAPID pair per run, so no key is kept in the repository; push requests are stubbed.
const vapid = await generateVapidKeys();

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // A fixed assets directory instead of ../web/dist: the merge gate runs `build` beside this
        // suite, and the pool failed with ENOENT when it listed web/dist while vite rewrote it.
        assets: { directory: "./test/assets" },
        bindings: {
          TEST_MIGRATIONS: migrations,
          SETUP_TOKEN: "test-setup-token-0123456789abcdef0123456789",
          VAPID_PUBLIC_KEY: vapid.publicKey,
          VAPID_PRIVATE_KEY: vapid.privateKey,
          VAPID_SUBJECT: "https://mail.test",
          // Requests to Resend are stubbed in every test; these values reach no real account.
          // The upstream URLs name reserved .invalid hosts (RFC 6761): a request that slips past
          // the fetch stubs cannot resolve, so it never reaches the real service.
          RESEND_API_URL: "https://api.resend.invalid",
          DOH_URL: "https://doh.invalid/dns-query",
          RESEND_API_KEY: "re_test_not_a_real_key",
          RESEND_WEBHOOK_SECRET: `whsec_${btoa(crypto.randomUUID())}`,
          UPLOAD_URL_KEY: crypto.randomUUID(),
          // Set here so a token in a local .dev.vars never reaches the tests; Telegram is stubbed.
          TELEGRAM_BOT_TOKEN: "123456:test-not-a-real-token",
          TELEGRAM_API_URL: "https://api.telegram.invalid",
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
          include: [
            "@simplewebauthn/server",
            "@simplewebauthn/server/helpers",
            "resend",
            "standardwebhooks",
          ],
        },
      },
    },
  },
});
