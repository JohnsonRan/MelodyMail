import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { STALE_AFTER_MS } from "../src/backup/alert";
import { runExport } from "../src/backup/export";
import { type ExportRow, exportsToDrop } from "../src/backup/prune";
import { EXPORT_PREFIX, exportIdOf } from "../src/backup/sql";
import { handleScheduled } from "../src/mail/consumer";
import { DAY, HOUR, latestState, START } from "./backup-helpers";

const complete = (startedAt: number): ExportRow => ({
  id: exportIdOf(startedAt),
  status: "complete",
  startedAt,
});

describe("retention", () => {
  it("keeps the 14 newest and each month's first for 6 months; drops incomplete after 2 days", () => {
    const now = Date.UTC(2026, 10, 30, 4);
    // Daily exports from 2026-03-01 to 2026-11-30.
    const rows: ExportRow[] = [];
    for (let t = Date.UTC(2026, 2, 1, 3); t <= now; t += DAY) rows.push(complete(t));
    rows.push({ id: "failed-old", status: "failed", startedAt: now - 2 * DAY });
    rows.push({ id: "failed-young", status: "failed", startedAt: now - 2 * DAY + 1 });
    rows.push({ id: "running", status: "running", startedAt: now - HOUR });
    const dropped = new Set(exportsToDrop(rows, now));
    const kept = rows.filter((r) => !dropped.has(r.id)).map((r) => r.id);
    expect(kept).toEqual([
      "2026-06-01T0300Z",
      "2026-07-01T0300Z",
      "2026-08-01T0300Z",
      "2026-09-01T0300Z",
      "2026-10-01T0300Z",
      "2026-11-01T0300Z",
      ...Array.from({ length: 14 }, (_, i) => exportIdOf(Date.UTC(2026, 10, 17 + i, 3))),
      "failed-young",
      "running",
    ]);
    expect(dropped.has("failed-old")).toBe(true);
    expect(dropped.has("2026-05-01T0300Z")).toBe(true);
  });
});

/** An export row and its objects, written straight to storage. */
async function seedExport(id: string, startedAt: number, status = "complete", parts = 2) {
  await env.DB.prepare("INSERT INTO backup_exports (id, status, started_at) VALUES (?, ?, ?)")
    .bind(id, status, startedAt)
    .run();
  for (let i = 0; i < parts; i++) await env.MAIL.put(`${EXPORT_PREFIX}${id}/part-x-${i}.sql`, "x");
  if (status === "complete") await env.MAIL.put(`${EXPORT_PREFIX}${id}/manifest.json`, "{}");
}

const objectsUnder = async (id: string) =>
  (await env.MAIL.list({ prefix: `${EXPORT_PREFIX}${id}/` })).objects.length;

describe("pruning", () => {
  it("runs once after an export completes, removes what retention drops, and skips a locked export", async () => {
    // 17 daily exports in one month: the 2nd and 3rd go (the 1st is the month's first), and an
    // old failed one.
    const base = Date.UTC(2026, 10, 2, 3);
    for (let i = 0; i < 17; i++) await seedExport(exportIdOf(base + i * DAY), base + i * DAY);
    await seedExport("failed", base - 3 * DAY, "failed");
    const now = base + 17 * DAY - HOUR;
    const del = env.MAIL.delete.bind(env.MAIL);
    // A bucket lock refuses the failed export's objects.
    vi.spyOn(env.MAIL, "delete").mockImplementation(async (keys) => {
      if (String(keys).includes("/failed/")) throw new Error("object is locked");
      return del(keys);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runExport(env, now);

    expect(await objectsUnder(exportIdOf(base + DAY))).toBe(0);
    expect(await objectsUnder(exportIdOf(base + 2 * DAY))).toBe(0);
    expect(await objectsUnder(exportIdOf(base))).toBe(3);
    expect(await objectsUnder(exportIdOf(base + 3 * DAY))).toBe(3);
    expect(await objectsUnder("failed")).toBe(2);
    expect(warn.mock.calls.join(" ")).toContain('"event":"backup_prune_failed"');
    const { results } = await env.DB.prepare(
      "SELECT id FROM backup_exports WHERE pruned_at IS NOT NULL",
    ).all();
    expect(results).toEqual([{ id: exportIdOf(base + 16 * DAY) }]);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM backup_exports").first<{ n: number }>())?.n,
    ).toBe(16);

    // Pruning ran for this export; the next run does not list again.
    const list = vi.spyOn(env.MAIL, "list");
    await runExport(env, now + 15 * 60 * 1000);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("alerts", () => {
  const bindTelegram = () =>
    env.DB.prepare(
      `INSERT INTO telegram (id, bot_username, origin, webhook_secret_hash, chat_id, language, updated_at)
       VALUES (1, 'bot', 'https://mail.test', 'h', 42, 'zh-CN', 0)`,
    ).run();

  it("a failing export leaves the other cron jobs running, logs, and sends one Telegram message a day", async () => {
    await bindTelegram();
    await env.DB.prepare(
      "INSERT INTO webhook_events (svix_id, received_at) VALUES ('old', 0)",
    ).run();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, result: { message_id: 1 } }));
    vi.spyOn(env.MAIL, "put").mockRejectedValue(new Error("r2 down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("INSERT INTO domains (name, created_at) VALUES ('example.com', 0)").run();

    await expect(
      handleScheduled({ scheduledTime: START } as ScheduledController, env),
    ).rejects.toThrow("1 cron job(s) failed");
    expect(await env.DB.prepare("SELECT * FROM webhook_events").first()).toBeNull();
    const logged = error.mock.calls.join(" ");
    expect(logged).toContain('"event":"backup_export_failed"');
    expect(logged).toContain('"job":"backup_export"');
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ chat_id: 42, text: expect.stringContaining("备份失败") });

    // The same failure later that day logs again but sends nothing more.
    await expect(runExport(env, START + 15 * 60 * 1000)).rejects.toThrow("r2 down");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(runExport(env, START + DAY)).rejects.toThrow("r2 down");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("logs backup_stale once a day when the newest complete export is older than 48 hours", async () => {
    // Before the day's start: the newest complete export is 71 hours old, a failed one is today's.
    const now = START - DAY - HOUR;
    await seedExport(exportIdOf(START - 4 * DAY), START - 4 * DAY);
    await seedExport(exportIdOf(START - 2 * DAY), START - 2 * DAY, "failed");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stale = () => error.mock.calls.filter((c) => String(c).includes("backup_stale")).length;
    await runExport(env, START - 4 * DAY + STALE_AFTER_MS - 1);
    expect(stale()).toBe(0);
    await runExport(env, now);
    expect(stale()).toBe(1);
    await runExport(env, now + 15 * 60 * 1000);
    expect(stale()).toBe(1);
    expect((await latestState())?.alerted_at).toBe(now);
    await runExport(env, now + DAY);
    expect(stale()).toBe(2);
  });
});
