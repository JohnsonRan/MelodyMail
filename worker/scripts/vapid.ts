// Prints a fresh VAPID key pair for Web Push, in .dev.vars form (README, "Notifications").
// The private key is a Worker secret: store it with `wrangler secret put`, never in a file in git.
import { generateVapidKeys } from "@mmmike/web-push/vapid";

const { publicKey, privateKey } = await generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
