// What `wrangler types` would generate: ties ctx.exports and the test `exports` to this
// Worker's entry module, and declares the bindings in wrangler.jsonc. Written by hand because
// wrangler does not run under Bun.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    AUTH_LIMITER: RateLimit;
    /** Raw inbound messages. */
    MAIL: R2Bucket;
    /** Producer for melodymail-inbound; the body is { id } of a stored message. */
    INBOUND: Queue<InboundJob>;
    /** Worker secret for first-run setup; setup is refused while it is unset or too short. */
    SETUP_TOKEN?: string;
    /** DNS-over-HTTPS JSON API used by the domain DNS check. */
    DOH_URL: string;
  }
}

/** The inbound queue message: the id of a messages row with status "stored". */
type InboundJob = { id: string };
