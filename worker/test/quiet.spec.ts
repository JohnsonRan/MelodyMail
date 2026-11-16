import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ORIGIN } from "./helpers";
import { report } from "./hub-helpers";
import { seedMessage } from "./mailbox-helpers";
import { signedIn } from "./send-helpers";
import { notifyNewMail, ok, seedTelegram, stubTelegram } from "./telegram-helpers";

// "Quiet while MelodyMail is open" (docs/M5c-foreground.md, "Owner ruling: a switch, default
// off"): the setting route and the Hub's reading of it.

const open: WebSocket[] = [];
afterEach(() => {
  for (const ws of open.splice(0)) ws.close();
});

describe("quiet setting", () => {
  it("is off by default and changes with a normal session, without a fresh passkey", async () => {
    const client = await signedIn();
    expect(await client.json("GET", "/api/settings/quiet")).toEqual({ quietForeground: false });
    expect(await client.json("PUT", "/api/settings/quiet", { quietForeground: true })).toEqual({
      quietForeground: true,
    });
    expect(await client.json("GET", "/api/settings/quiet")).toEqual({ quietForeground: true });
    expect(await client.json("PUT", "/api/settings/quiet", { quietForeground: false })).toEqual({
      quietForeground: false,
    });
    expect(await client.json("GET", "/api/settings/quiet")).toEqual({ quietForeground: false });
  });

  it("refuses anything but a boolean", async () => {
    const client = await signedIn();
    for (const body of [{}, { quietForeground: 1 }, { quietForeground: "true" }, []]) {
      const res = await client.request("PUT", "/api/settings/quiet", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect(await client.json("GET", "/api/settings/quiet")).toEqual({ quietForeground: false });
  });

  it("notifies as usual when the setting cannot be read", async () => {
    await seedTelegram();
    await seedMessage({ id: "m1" });
    const client = await signedIn();
    await client.json("PUT", "/api/settings/quiet", { quietForeground: true });
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await exports.default.fetch(`${ORIGIN}/api/events`, {
      headers: { upgrade: "websocket", origin: ORIGIN, cookie },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    open.push(ws);
    await report(ws, "fg");
    const calls = stubTelegram(() => ok({ message_id: 42, chat: { id: 1 } }));
    const warn = vi.spyOn(console, "warn");
    await env.DB.exec("ALTER TABLE settings RENAME TO settings_gone");
    try {
      expect(await notifyNewMail("m1")).toBe(1);
    } finally {
      await env.DB.exec("ALTER TABLE settings_gone RENAME TO settings");
    }
    expect(calls.map((c) => c.method)).toEqual(["sendWidget"]);
    expect(warn.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toContain(
      "quiet_setting_failed",
    );
  });
});
