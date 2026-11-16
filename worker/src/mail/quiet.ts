import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { fail, readJson } from "../http";

// "Quiet while MelodyMail is open" (docs/M5c-foreground.md, "Owner ruling: a switch, default
// off"). On: no Web Push and no Telegram message for new mail while any page is in the foreground.
// Off, the default: the Hub notifies as in M5b. A normal session may change it; it guards no
// secret and loses no mail.

/** Whether the owner turned the setting on; a missing row is the default, off. */
export async function quietForeground(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT quiet_foreground AS quiet FROM settings WHERE id = 1")
    .first<{ quiet: number }>();
  return row?.quiet === 1;
}

export function registerQuietRoutes(app: Hono<AppEnv>): void {
  app.get("/", async (c) => c.json({ quietForeground: await quietForeground(c.env.DB) }));

  app.put("/", async (c) => {
    const body = await readJson(c);
    if (typeof body?.quietForeground !== "boolean") return fail(c, 400, "bad_request");
    const on = body.quietForeground;
    await c.env.DB.prepare(
      `INSERT INTO settings (id, quiet_foreground, updated_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET quiet_foreground = excluded.quiet_foreground,
         updated_at = excluded.updated_at`,
    )
      .bind(on ? 1 : 0, Date.now())
      .run();
    return c.json({ quietForeground: on });
  });
}
