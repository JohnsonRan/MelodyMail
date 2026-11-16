import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { openSession, type Session, shutdown } from "./browser";

// End to end through the built app (web/dist) in Chromium: the real router, list, reader chunk,
// Web Worker parse and sandboxed frame. The Worker API is replaced by an in-memory stub that
// answers like the routes in worker/src/mail; the Worker itself is covered by its own suite.

const DIST = join(import.meta.dir, "..", "dist");
const TRACKER = "https://tracker.invalid";

const HOSTILE = [
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

const ATTACHMENT = [
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

const PLAIN = (n: number) =>
  [
    "From: Friend <friend@example.org>",
    "To: shop@example.com",
    `Subject: Note ${n}`,
    `Message-ID: <note${n}@example.org>`,
    "",
    `Plain note ${n}.`,
    "",
  ].join("\r\n");

type Stored = { item: Record<string, unknown>; raw: string };

let store: Map<string, Stored>;
let patches: { path: string; body: Record<string, unknown> }[];
let sockets: Set<ServerWebSocket<undefined>>;
let server: Server<undefined>;
let origin: string;

function message(id: string, raw: string, subject: string, receivedAt: number, extra = {}) {
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
      hasAttachments: false,
      status: "parsed",
      threadKey: null,
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

function reset() {
  const now = Date.now();
  store = new Map(
    [
      message("hostile", HOSTILE, "Hostile", now),
      message("invoice", ATTACHMENT, "Invoice", now - 1000, { hasAttachments: true }),
      ...[1, 2, 3].map((n) => message(`note${n}`, PLAIN(n), `Note ${n}`, now - 2000 - n)),
    ].map((m) => [m.item.id as string, m]),
  );
  patches = [];
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

function inFolder(item: Record<string, unknown>, folder: string) {
  if (folder === "trash") return item.trashed;
  if (folder === "archive") return item.archived && !item.trashed;
  if (folder === "starred") return item.starred && !item.trashed;
  return !item.archived && !item.trashed;
}

async function api(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/auth/state") return json({ initialized: true, authenticated: true });
  if (path === "/api/addresses") {
    return json({ addresses: [{ id: 1, address: "shop@example.com", targetIds: [] }] });
  }
  if (path === "/api/counts") {
    return json({ folders: { inbox: 0, starred: 0, archive: 0, trash: 0 }, addresses: {} });
  }
  if (path === "/api/messages" && req.method === "GET") {
    const folder = url.searchParams.get("folder") ?? "inbox";
    const items = [...store.values()].map((m) => m.item).filter((i) => inFolder(i, folder));
    items.sort((a, b) => (b.receivedAt as number) - (a.receivedAt as number));
    return json({ messages: items, nextCursor: null });
  }
  if (req.method === "PATCH") {
    const body = (await req.json()) as Record<string, unknown>;
    patches.push({ path, body });
    const ids = path === "/api/messages" ? (body.ids as string[]) : [path.split("/").pop() ?? ""];
    for (const id of ids) {
      const m = store.get(id);
      if (m) Object.assign(m.item, { ...body, ids: undefined });
    }
    return json({ ok: true });
  }
  const match = /^\/api\/messages\/([^/]+)(\/thread|\/raw)?$/.exec(path);
  const m = match ? store.get(match[1] ?? "") : undefined;
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
  return json({ messages: [m.item] });
}

beforeAll(() => {
  if (!existsSync(join(DIST, "index.html"))) throw new Error("build web/dist first: bun run build");
  sockets = new Set();
  server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/api/events") {
        return srv.upgrade(req) ? undefined : json({ error: "upgrade_required" }, 426);
      }
      if (url.pathname.startsWith("/api/")) return api(req, url);
      const file = Bun.file(join(DIST, url.pathname));
      if (url.pathname.startsWith("/assets/") && (await file.exists())) return new Response(file);
      return new Response(Bun.file(join(DIST, "index.html")));
    },
    websocket: {
      open: (ws) => {
        sockets.add(ws);
      },
      close: (ws) => {
        sockets.delete(ws);
      },
      message: (ws, data) => {
        if (data === "ping") ws.send("pong");
      },
    },
  });
  origin = server.url.origin;
});

let session: Session | null = null;

beforeEach(async () => {
  reset();
  await session?.page.close();
  session = null;
});

afterAll(async () => {
  await session?.page.close();
  await shutdown();
  await server.stop(true);
});

async function open(path = "/", width = 1280, mode = "light"): Promise<Session> {
  session = await openSession(origin, path);
  await session.page.setViewportSize({ width, height: 900 });
  await session.page.addInitScript((m) => localStorage.setItem("melodymail.mode", m), mode);
  await session.page.addInitScript(() => {
    (window as unknown as { posted: string[] }).posted = [];
    window.addEventListener("message", (e) =>
      (window as unknown as { posted: string[] }).posted.push(String(e.data)),
    );
  });
  await session.page.reload();
  await session.page.locator(`[data-message-row="note3"]`).waitFor();
  return session;
}

const row = (s: Session, id: string) => s.page.locator(`[data-message-row="${id}"]`);

describe("mailbox end to end", () => {
  test("loads the app without any third-party request and with its own font", async () => {
    const s = await open();
    await s.page.evaluate(() => document.fonts.ready);
    expect(s.remote).toEqual([]);
    expect(await s.page.evaluate(() => document.fonts.check('16px "Figtree"'))).toBe(true);
    const fontRequests = await s.page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => n.includes("figtree")),
    );
    expect(fontRequests.length).toBeGreaterThan(0);
    for (const url of fontRequests) expect(url).toStartWith(`${origin}/assets/`);
  });

  test("renders hostile HTML only in the sandboxed frame and loads nothing remote", async () => {
    const s = await open();
    await row(s, "hostile").click();
    const frame = s.page.locator("iframe");
    await frame.waitFor();
    expect(await frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcdoc = (await frame.getAttribute("srcdoc")) ?? "";
    expect(srcdoc).toStartWith(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    );
    expect(srcdoc).not.toMatch(/<script|onerror=|http-equiv="refresh"|<form|javascript:/i);
    const inner = s.page.frameLocator("iframe").locator("#greeting");
    expect(await inner.textContent()).toBe("Hello");
    await s.page.waitForTimeout(300);
    expect(s.remote).toEqual([]);
    expect(await s.page.evaluate(() => (window as unknown as { posted: string[] }).posted)).toEqual(
      [],
    );
    expect(patches).toContainEqual({ path: "/api/messages/hostile", body: { read: true } });
    // The owner's choice loads the images, and the capture sees them.
    await s.page.getByRole("button", { name: "Show remote images" }).click();
    await s.page.waitForTimeout(300);
    expect(s.remoteFromFrames).toContain(`${TRACKER}/pixel.gif`);
  });

  test("inverts an HTML message only on request, in the dark theme, with the frame unchanged", async () => {
    const light = await open();
    await row(light, "hostile").click();
    await light.page.locator("iframe").waitFor();
    expect(await light.page.getByRole("button", { name: "Dark reading" }).count()).toBe(0);
    const s = await open("/", 1280, "dark");
    await row(s, "hostile").click();
    const frame = s.page.locator("iframe");
    await frame.waitFor();
    const before = (await frame.getAttribute("srcdoc")) ?? "";
    expect(before).not.toContain("invert(");
    const toggle = s.page.getByRole("button", { name: "Dark reading" });
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    await toggle.click();
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    await s.page.waitForFunction(() =>
      document.querySelector("iframe")?.getAttribute("srcdoc")?.includes("invert("),
    );
    const after = (await frame.getAttribute("srcdoc")) ?? "";
    expect(after.slice(0, before.indexOf("<style>"))).toBe(
      before.slice(0, before.indexOf("<style>")),
    );
    expect(await frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(await s.page.frameLocator("iframe").locator("#greeting").textContent()).toBe("Hello");
    await s.page.waitForTimeout(300);
    expect(s.remote).toEqual([]);
    expect(await s.page.evaluate(() => (window as unknown as { posted: string[] }).posted)).toEqual(
      [],
    );
    // It combines with "Show remote images", and a plain-text message offers no toggle.
    await s.page.getByRole("button", { name: "Show remote images" }).click();
    await s.page.waitForFunction(() =>
      document.querySelector("iframe")?.getAttribute("srcdoc")?.includes("img-src data: https:"),
    );
    expect((await frame.getAttribute("srcdoc")) ?? "").toContain("invert(");
    await row(s, "note1").click();
    await s.page.getByText("Plain note 1.").waitFor();
    expect(await toggle.count()).toBe(0);
  });

  test("downloads an HTML attachment and never opens it", async () => {
    const s = await open();
    await row(s, "invoice").click();
    const link = s.page.getByRole("link", { name: "https://example.org/invoice" });
    expect(await link.getAttribute("target")).toBe("_blank");
    expect(await link.getAttribute("rel")).toContain("noopener");
    expect(await link.getAttribute("rel")).toContain("noreferrer");
    const [download] = await Promise.all([
      s.page.waitForEvent("download"),
      s.page.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("invoice.html");
    await s.page.waitForTimeout(300);
    expect(s.popups).toEqual([]);
    expect(s.page.url()).toBe(`${origin}/?m=invoice`);
  });

  test("works from the keyboard", async () => {
    const s = await open();
    await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await s.page.keyboard.press("j");
    expect(
      await s.page.evaluate(() => document.activeElement?.getAttribute("data-message-row")),
    ).toBe("invoice");
    await s.page.keyboard.press("Enter");
    await s.page.waitForURL(/m=invoice/);
    await s.page.keyboard.press("s");
    await s.page.waitForTimeout(200);
    expect(patches).toContainEqual({ path: "/api/messages/invoice", body: { starred: true } });
    await s.page.keyboard.press("e");
    await s.page.waitForTimeout(200);
    expect(patches).toContainEqual({ path: "/api/messages/invoice", body: { archived: true } });
    expect(await row(s, "invoice").count()).toBe(0);
    await s.page.keyboard.press("/");
    expect(await s.page.evaluate(() => document.activeElement?.getAttribute("type"))).toBe(
      "search",
    );
  });

  test("archives the selected messages at once", async () => {
    const s = await open();
    await row(s, "note1").getByRole("checkbox").check();
    await row(s, "note2").getByRole("checkbox").check();
    await s.page.getByRole("button", { name: "Archive" }).first().click();
    await s.page.waitForTimeout(200);
    expect(patches).toContainEqual({
      path: "/api/messages",
      body: { ids: expect.arrayContaining(["note1", "note2"]), archived: true },
    });
    expect(await row(s, "note1").count()).toBe(0);
    expect(await row(s, "note3").count()).toBe(1);
  });

  test("shows one pane at a time at phone width without sideways scroll", async () => {
    const s = await open("/", 390);
    expect(await s.page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await row(s, "note1").click();
    await s.page.getByRole("button", { name: "Back to the list" }).click();
    await row(s, "note3").waitFor();
    expect(await s.page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });

  test("puts new mail on top when the hub sends an event", async () => {
    const s = await open();
    const fresh = message("fresh", PLAIN(9), "Fresh mail", Date.now() + 1000);
    store.set("fresh", fresh);
    for (const ws of sockets) ws.send(JSON.stringify({ type: "message", id: "fresh" }));
    await row(s, "fresh").waitFor();
    expect(
      await s.page.locator("[data-message-row]").first().getAttribute("data-message-row"),
    ).toBe("fresh");
  });
});
