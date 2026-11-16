// Prints a fresh UPLOAD_URL_KEY: 32 random bytes, base64url (README, "Sending"). It signs the
// attachment URLs Resend fetches; store it with `wrangler secret put`, never in a file in git.
import { isoBase64URL } from "@simplewebauthn/server/helpers";

console.log(
  `UPLOAD_URL_KEY=${isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)))}`,
);
