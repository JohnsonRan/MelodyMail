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
    /** Abuse guard on the push test send, keyed by session. */
    PUSH_LIMITER: RateLimit;
    /** Raw inbound messages. */
    MAIL: R2Bucket;
    /** Producer for melodymail-inbound; the body is { id } of a stored message. */
    INBOUND: Queue<InboundJob>;
    /** The real-time push hub; one object named "hub". */
    HUB: DurableObjectNamespace<import("./mail/hub").Hub>;
    /** Worker secret for first-run setup; setup is refused while it is unset or too short. */
    SETUP_TOKEN?: string;
    /** DNS-over-HTTPS JSON API used by the domain DNS check. */
    DOH_URL: string;
    /** Web Push (VAPID) public key, base64url; push is off while any VAPID value is unset. */
    VAPID_PUBLIC_KEY?: string;
    /** Worker secret: the VAPID private key, base64url. */
    VAPID_PRIVATE_KEY?: string;
    /** The app's own https:// origin, sent to push services as the VAPID subject. */
    VAPID_SUBJECT?: string;
    /** Worker secret: the Resend API key; sending is off while it is unset. */
    RESEND_API_KEY?: string;
    /** Worker secret: the Resend webhook signing secret (whsec_...); the webhook answers 404 without it. */
    RESEND_WEBHOOK_SECRET?: string;
    /** Worker secret: the HMAC key of the signed attachment URLs; attachments are off without it. */
    UPLOAD_URL_KEY?: string;
    /** The Resend API origin. */
    RESEND_API_URL: string;
    /** Plan limits shown with the quota (Resend Free: 100 per UTC day, 3,000 per month). */
    RESEND_DAILY_LIMIT: string;
    RESEND_MONTHLY_LIMIT: string;
  }
}

/** The inbound queue message: the id of a messages row with status "stored". */
type InboundJob = { id: string };
