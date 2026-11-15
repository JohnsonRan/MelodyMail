// What `wrangler types` would generate: ties ctx.exports and the test `exports` to this
// Worker's entry module. Written by hand because wrangler does not run under Bun.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
