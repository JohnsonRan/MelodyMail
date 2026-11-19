import type { Hono } from "hono";
import { audit } from "../auth/store";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";

// Settings > Spam senders (docs/M8-mailbox-ux.md, "Filing", forged senders): the senders Report
// spam remembered, with Remove, so a wrong entry is undone without finding a message. Session
// routes only. Audit rows name no address.

/** Senders listed per request: bounds the rows read. */
export const SENDERS_MAX = 1000;
/** Longer than any stored key (FROM_KEY_MAX in worker/src/mail/parse.ts). */
const ADDRESS_MAX = 320;

export function registerSpamSenderRoutes(senders: Hono<AppEnv>): void {
  senders.get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT address, created_at AS createdAt FROM spam_senders
       ORDER BY created_at DESC, address LIMIT ?`,
    )
      .bind(SENDERS_MAX)
      .all<{ address: string; createdAt: number }>();
    return c.json({ senders: results });
  });

  // Mail already in Spam stays there; only later mail is no longer filed.
  senders.delete("/", async (c) => {
    const address = (await readJson(c))?.address;
    if (typeof address !== "string" || address.length === 0 || address.length > ADDRESS_MAX) {
      return fail(c, 400, "bad_request");
    }
    const { meta } = await c.env.DB.prepare("DELETE FROM spam_senders WHERE address = ?")
      .bind(address)
      .run();
    const removed = meta.changes > 0;
    if (removed) await audit(c, "spam_sender_removed", Date.now()).run();
    return c.json({ removed });
  });
}
