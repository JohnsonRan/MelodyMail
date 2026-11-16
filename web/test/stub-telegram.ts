// The Telegram routes of the API stand-in (docs/M5b-telegram.md, "Routes"), answering like
// worker/src/telegram/routes.ts, and the Passkey step-up they need. It records the calls so a test
// can assert them; a test moves `status` to "on" to play the bot receiving /start.

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const CODE = "AbCdEfGhIjKlMnOpQrStUv";

export type TelegramCall = { method: string; path: string };

export class TelegramStub {
  status: Record<string, unknown> = { state: "off" };
  calls: TelegramCall[] = [];
  /** Set by POST /api/auth/reauth/verify; Connect answers reauth_required until then. */
  reauthed = false;
  /** The answer of POST /api/telegram/test; a failure also records lastError like the Worker. */
  testFails = false;

  handle(req: Request, url: URL): Response | null {
    const path = url.pathname;
    const method = req.method;
    if (path === "/api/auth/reauth/options") {
      this.calls.push({ method, path });
      const challenge = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      return json({
        options: {
          challenge,
          rpId: "localhost",
          allowCredentials: [],
          userVerification: "preferred",
        },
      });
    }
    if (path === "/api/auth/reauth/verify") {
      this.calls.push({ method, path });
      this.reauthed = true;
      return json({ ok: true });
    }
    if (!path.startsWith("/api/telegram")) return null;
    this.calls.push({ method, path });
    if (path === "/api/telegram" && method === "GET") return json(this.status);
    if (path === "/api/telegram/link" && method === "POST") {
      if (!this.reauthed) return json({ error: "reauth_required" }, 403);
      const expiresAt = Date.now() + 600_000;
      this.status = { state: "pending", expiresAt };
      return json({ url: `https://t.me/melody_test_bot?start=${CODE}`, code: CODE, expiresAt });
    }
    if (path === "/api/telegram/link" && method === "DELETE") {
      this.status = { state: "off" };
      return json({ ok: true });
    }
    if (path === "/api/telegram" && method === "DELETE") {
      this.status = { state: "off" };
      return json({ ok: true });
    }
    if (path === "/api/telegram/test" && method === "POST") {
      if (!this.testFails) return json({ ok: true });
      this.status = { ...this.status, lastError: "blocked" };
      return json({ error: "telegram_failed" }, 502);
    }
    return json({ error: "not_found" }, 404);
  }
}
