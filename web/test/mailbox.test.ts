import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import { message, PLAIN, StubApp, TRACKER } from "./stub-app";

// End to end through the built app (web/dist) in Chromium: the real router, list, reader chunk,
// Web Worker parse and sandboxed frame, against the API stand-in in stub-app.ts.

let app: StubApp;

beforeAll(() => {
  app = new StubApp();
});

let session: Session | null = null;

beforeEach(async () => {
  app.reset();
  await session?.page.close();
  session = null;
});

afterAll(async () => {
  await session?.page.close();
  await shutdown();
  await app.stop();
});

async function open(path = "/", width = 1280, mode = "light"): Promise<Session> {
  session = await openSession(app.origin, path);
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
    for (const url of fontRequests) expect(url).toStartWith(`${app.origin}/assets/`);
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
    expect(app.patches).toContainEqual({ path: "/api/messages/hostile", body: { read: true } });
    // Dark reading is offered only in the dark theme.
    expect(await s.page.getByRole("button", { name: "Dark reading" }).count()).toBe(0);
    // The owner's choice loads the images, and the capture sees them.
    await s.page.getByRole("button", { name: "Show remote images" }).click();
    await s.page.waitForTimeout(300);
    expect(s.remoteFromFrames).toContain(`${TRACKER}/pixel.gif`);
  });

  test("inverts an HTML message only on request, in the dark theme, with the frame unchanged", async () => {
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
    // Not remembered: back on the message, it is white again.
    await row(s, "hostile").click();
    await toggle.waitFor();
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("selects content only: chrome is not selectable, copyable values are", async () => {
    const s = await open();
    const select = (selector: string) =>
      s.page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).userSelect);
    const chrome = ["nav a", "[data-message-row]", "button"];
    for (const selector of chrome)
      expect([selector, await select(selector)]).toEqual([selector, "none"]);
    expect(await select("input[type=search]")).toBe("text");
    await row(s, "note1").click();
    await s.page.getByText("Plain note 1.").waitFor();
    expect(await select("h2")).toBe("text");
    expect(await select("text=Plain note 1.")).toBe("text");
    expect(await select(`text="To"`)).toBe("text");
    await s.page.goto(`${app.origin}/settings/domains/example.com`);
    await s.page.getByText("mx.test.example").waitFor();
    expect(await select("h1")).toBe("none");
    expect(await select("text=mx.test.example")).toBe("text");
    expect(await select(`text="MX"`)).toBe("text");
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
    expect(s.page.url()).toBe(`${app.origin}/?m=invoice`);
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
    expect(app.patches).toContainEqual({ path: "/api/messages/invoice", body: { starred: true } });
    await s.page.keyboard.press("e");
    await s.page.waitForTimeout(200);
    expect(app.patches).toContainEqual({ path: "/api/messages/invoice", body: { archived: true } });
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
    expect(app.patches).toContainEqual({
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
    app.store.set("fresh", fresh);
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "message", id: "fresh" }));
    await row(s, "fresh").waitFor();
    expect(
      await s.page.locator("[data-message-row]").first().getAttribute("data-message-row"),
    ).toBe("fresh");
  });
});
