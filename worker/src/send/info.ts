import type { Hono } from "hono";
import type { AppEnv } from "../env";

// What compose needs before the owner writes: the addresses that may send, whether sending and
// attachments are set up, and the last quota counts Resend reported.

type QuotaRow = { dailyUsed: number; monthlyUsed: number; seenAt: number };

/** Resend's counts are per UTC day and month; a count seen before the current one is 0 now. */
export function currentQuota(row: QuotaRow | null, now: number) {
  if (!row) return { daily: 0, monthly: 0, seenAt: null };
  const seen = new Date(row.seenAt);
  const today = new Date(now);
  const sameMonth =
    seen.getUTCFullYear() === today.getUTCFullYear() && seen.getUTCMonth() === today.getUTCMonth();
  const sameDay = sameMonth && seen.getUTCDate() === today.getUTCDate();
  return {
    daily: sameDay ? row.dailyUsed : 0,
    monthly: sameMonth ? row.monthlyUsed : 0,
    seenAt: row.seenAt,
  };
}

export function registerSendInfoRoutes(send: Hono<AppEnv>): void {
  send.get("/from", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.local_part || '@' || a.domain AS address, a.display_name AS displayName
       FROM addresses a JOIN domains d ON d.name = a.domain
       WHERE a.enabled = 1 AND d.send_enabled = 1 ORDER BY a.domain, a.local_part`,
    ).all<{ id: number; address: string; displayName: string }>();
    return c.json({
      configured: Boolean(c.env.RESEND_API_KEY),
      attachments: Boolean(c.env.UPLOAD_URL_KEY),
      addresses: results,
    });
  });

  send.get("/quota", async (c) => {
    const row = await c.env.DB.prepare(
      "SELECT daily_used AS dailyUsed, monthly_used AS monthlyUsed, seen_at AS seenAt FROM send_quota WHERE id = 1",
    ).first<QuotaRow>();
    const used = currentQuota(row, Date.now());
    return c.json({
      daily: { used: used.daily, limit: Number(c.env.RESEND_DAILY_LIMIT) },
      monthly: { used: used.monthly, limit: Number(c.env.RESEND_MONTHLY_LIMIT) },
      seenAt: used.seenAt,
    });
  });
}
