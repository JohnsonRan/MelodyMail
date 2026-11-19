import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { KeysStub } from "./stub-keys";
import { MailboxStub, type Stored } from "./stub-mailbox";
import { RulesStub } from "./stub-rules";
import { SendStub } from "./stub-send";
import { TelegramStub } from "./stub-telegram";

// The built app (web/dist) behind an in-memory stand-in for the Worker API, shared by the end to
// end suites. It answers like the routes in worker/src; the Worker itself has its own suite.
// Static files are served as Cloudflare's assets do: a file that exists, else index.html.

const DIST = join(import.meta.dir, "..", "dist");
export const TRACKER = "https://tracker.invalid";

export const HOSTILE = [
  "From: Mallory <mallory@example.org>",
  "To: shop@example.com",
  "Subject: Hostile",
  "Message-ID: <hostile@example.org>",
  "Content-Type: text/html; charset=utf-8",
  "",
  `<p id="greeting">Hello</p><script>parent.postMessage("script","*")</script>`,
  `<img src="x" onerror="parent.postMessage('onerror','*')"><img src="${TRACKER}/pixel.gif">`,
  `<meta http-equiv="refresh" content="0;url=${TRACKER}/refresh"><form action="${TRACKER}/f"><input></form>`,
  `<style>@import url(${TRACKER}/i.css); p{background:url(${TRACKER}/bg.png)}</style>`,
  `<a href="javascript:parent.postMessage('js','*')">x</a>`,
  "",
].join("\r\n");

export const ATTACHMENT = [
  "From: Sender <sender@example.org>",
  "To: shop@example.com",
  "Subject: Invoice",
  "Message-ID: <invoice@example.org>",
  'Content-Type: multipart/mixed; boundary="mix"',
  "",
  "--mix",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "See https://example.org/invoice for details.",
  "--mix",
  'Content-Type: text/html; name="invoice.html"',
  'Content-Disposition: attachment; filename="invoice.html"',
  "",
  "<script>opener && opener.postMessage('attachment ran','*')</script>",
  "--mix--",
  "",
].join("\r\n");

export const PLAIN = (n: number) =>
  [
    "From: Friend <friend@example.org>",
    "To: shop@example.com",
    `Subject: Note ${n}`,
    `Message-ID: <note${n}@example.org>`,
    "",
    `Plain note ${n}.`,
    "",
  ].join("\r\n");

export type { Stored };

export function message(id: string, raw: string, subject: string, receivedAt: number, extra = {}) {
  return {
    item: {
      id,
      addressId: 1,
      tag: null,
      from: "Sender <sender@example.org>",
      subject,
      snippet: `${subject} snippet`,
      receivedAt,
      date: null,
      size: raw.length,
      read: false,
      starred: false,
      archived: false,
      trashed: false,
      spam: false,
      hasAttachments: false,
      status: "parsed",
      threadKey: null,
      direction: "in",
      error: null,
      to: "shop@example.com",
      cc: null,
      envelopeFrom: "sender@example.org",
      envelopeTo: "shop@example.com",
      forwardFailed: 0,
      ...extra,
    },
    raw,
  };
}

function seed(): Map<string, Stored> {
  const now = Date.now();
  return new Map(
    [
      message("hostile", HOSTILE, "Hostile", now),
      message("invoice", ATTACHMENT, "Invoice", now - 1000, { hasAttachments: true }),
      ...[1, 2, 3].map((n) => message(`note${n}`, PLAIN(n), `Note ${n}`, now - 2000 - n)),
    ].map((m) => [m.item.id as string, m]),
  );
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export type PushCall = { method: string; path: string; body: unknown };

/** One running stand-in: its origin, what the app sent it, and the open live-update sockets. */
export class StubApp {
  store = seed();
  send = new SendStub();
  telegram = new TelegramStub();
  rules = new RulesStub();
  keys = new KeysStub(() => this.telegram.reauthed);
  patches: { path: string; body: Record<string, unknown> }[] = [];
  mailbox = new MailboxStub(() => this.store, this.patches);
  push: PushCall[] = [];
  /** null answers GET /api/push/key with 404, as a Worker without VAPID keys does. */
  pushKey: string | null = null;
  sockets = new Set<ServerWebSocket<undefined>>();
  /** What pages sent over the socket besides "ping": their "fg" and "bg" reports. */
  reports: string[] = [];
  /** "Quiet while MelodyMail is open" (GET and PUT /api/settings/quiet). */
  quiet = false;
  /** Replaces a static file's body, for example a new sw.js. */
  overrides = new Map<string, string>();
  readonly server: Server<undefined>;

  constructor() {
    if (!existsSync(join(DIST, "index.html")))
      throw new Error("build web/dist first: bun run build");
    this.server = Bun.serve({
      port: 0,
      fetch: async (req, srv) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/events") {
          return srv.upgrade(req) ? undefined : json({ error: "upgrade_required" }, 426);
        }
        if (url.pathname.startsWith("/api/")) return this.api(req, url);
        return this.file(url.pathname);
      },
      websocket: {
        open: (ws) => {
          this.sockets.add(ws);
        },
        close: (ws) => {
          this.sockets.delete(ws);
        },
        message: (ws, data) => {
          if (data === "ping") ws.send("pong");
          else this.reports.push(String(data));
        },
      },
    });
  }

  get origin(): string {
    return this.server.url.origin;
  }

  reset(): void {
    this.store = seed();
    this.send = new SendStub();
    this.telegram = new TelegramStub();
    this.rules = new RulesStub();
    this.keys = new KeysStub(() => this.telegram.reauthed);
    this.patches = [];
    this.mailbox = new MailboxStub(() => this.store, this.patches);
    this.push = [];
    this.reports = [];
    this.quiet = false;
    this.pushKey = null;
    this.overrides.clear();
  }

  stop(): Promise<void> {
    return this.server.stop(true);
  }

  private async file(path: string): Promise<Response> {
    const override = this.overrides.get(path);
    if (override !== undefined) {
      return new Response(override, { headers: { "content-type": "text/javascript" } });
    }
    const file = Bun.file(join(DIST, path));
    if (path !== "/" && !path.includes("..") && (await file.exists())) {
      const type = path.endsWith(".webmanifest") ? "application/manifest+json" : file.type;
      return new Response(file, { headers: { "content-type": type } });
    }
    return new Response(Bun.file(join(DIST, "index.html")));
  }

  private async api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/api/auth/state") return json({ initialized: true, authenticated: true });
    if (path === "/api/addresses") {
      return json({ addresses: [{ id: 1, address: "shop@example.com", targetIds: [] }] });
    }
    if (path === "/api/domains/example.com/dns") {
      return json({
        receive: [{ id: "mx", type: "MX", name: "@", values: ["mx.test.example"] }],
        send: [],
      });
    }
    if (path.startsWith("/api/push/")) {
      const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json();
      this.push.push({ method: req.method, path, body });
      if (path === "/api/push/key") {
        return this.pushKey
          ? json({ key: this.pushKey })
          : json({ error: "push_not_configured" }, 404);
      }
      return json({ ok: true });
    }
    if (path === "/api/settings/quiet") {
      if (req.method === "PUT")
        this.quiet = ((await req.json()) as { quietForeground: boolean }).quietForeground;
      return json({ quietForeground: this.quiet });
    }
    const telegram = this.telegram.handle(req, url);
    if (telegram) return telegram;
    const rules = await this.rules.handle(req, url);
    if (rules) return rules;
    const keys = await this.keys.handle(req, url);
    if (keys) return keys;
    const sending = await this.send.handle(req, url, this.store);
    if (sending) return sending;
    const mailbox = await this.mailbox.handle(req, url);
    if (mailbox) return mailbox;
    const match = /^\/api\/messages\/([^/]+)(\/thread|\/raw)?$/.exec(path);
    const m = match ? this.store.get(match[1] ?? "") : undefined;
    if (!m) return json({ error: "not_found" }, 404);
    if (match?.[2] === "/raw") {
      return new Response(m.raw, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment",
          "x-content-type-options": "nosniff",
        },
      });
    }
    return match?.[2] === "/thread" ? json({ messages: [m.item] }) : json({ message: m.item });
  }
}
