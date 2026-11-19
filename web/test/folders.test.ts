import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Page, Route } from "playwright";
import { openSession, type Session, shutdown } from "./browser";
import { HOSTILE, message, PLAIN, StubApp } from "./stub-app";

// The M8 mailbox behaviours through the built app (docs/M8-mailbox-ux.md): the Spam folder,
// Report spam and Not spam, Delete forever and Empty with their loops, select all matching, and
// the `filed` event, against the API stand-in (stub-mailbox.ts).

let app: StubApp;
let session: Session | null = null;

beforeAll(() => {
  app = new StubApp();
});

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

async function open(path: string, ready: string): Promise<Page> {
  session = await openSession(app.origin, path, {
    prepare: (page) => page.setViewportSize({ width: 1280, height: 900 }),
  });
  await session.page.locator(ready).first().waitFor();
  return session.page;
}

/** A toast is in the live region and on screen; the first is enough. */
const text = (page: Page, value: string | RegExp) => page.getByText(value).first();
const row = (page: Page, id: string) => page.locator(`[data-message-row="${id}"]`);
const bar = (page: Page) => page.getByRole("toolbar", { name: "Actions on selected messages" });

/** Adds `n` messages `${prefix}0..` with these flags, newest first. */
function fill(prefix: string, n: number, flags: Record<string, unknown> = {}) {
  const base = Date.now() - 10_000;
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    app.store.set(id, message(id, PLAIN(i), `${prefix} ${i}`, base - i, flags));
  }
}

type Gate = { release: () => void; seen: string[]; answered: string[] };

/**
 * Holds the matching requests until `release`. With `snapshot`, the stand-in answers at once and
 * only the answer is held, so it reflects the store as it was when the request began; `answered`
 * lists the requests whose answer is taken.
 */
async function hold(
  page: Page,
  match: (url: URL, method: string) => boolean,
  snapshot = false,
): Promise<Gate> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const answered: string[] = [];
  await page.route(
    () => true,
    async (route: Route) => {
      const req = route.request();
      if (!match(new URL(req.url()), req.method())) return route.fallback();
      seen.push(req.url());
      if (snapshot) {
        const response = await route.fetch();
        answered.push(req.url());
        await gate;
        return route.fulfill({ response });
      }
      await gate;
      return route.continue();
    },
  );
  return { release, seen, answered };
}

const isPurge = (url: URL, method: string) =>
  method === "POST" && url.pathname === "/api/messages/purge";
const isList = (url: URL, method: string) => method === "GET" && url.pathname === "/api/messages";
const purges = () => app.mailbox.calls.filter((c) => c.path === "/api/messages/purge");

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(20);
  expect(check()).toBe(true);
}

describe("Spam", () => {
  test("lists Spam below Archive with its unread count, its actions and 30-day note", async () => {
    fill("junk", 2, { spam: true });
    const page = await open("/spam", `[data-message-row="junk0"]`);
    const nav = page.getByRole("navigation", { name: "Side navigation" });
    const names = (await nav.getByRole("link").allTextContents()).map((n) => n.replace(/\d.*/, ""));
    expect(names.slice(names.indexOf("Archive"), names.indexOf("Archive") + 3)).toEqual([
      "Archive",
      "Spam",
      "Trash",
    ]);
    expect(await nav.getByRole("link", { name: /^Spam/ }).textContent()).toContain("2");
    expect(await row(page, "note1").count()).toBe(0);
    await text(page, "Mail in Spam for 30 days is deleted forever.").waitFor();
    expect(
      await bar(page)
        .getByRole("button")
        .evaluateAll((b) => b.map((e) => e.ariaLabel ?? e.textContent)),
    ).toEqual(["Not spam", "Delete forever", "Star", "Mark as read", "Empty Spam"]);
    await page.getByRole("button", { name: "Empty Spam" }).waitFor();
    // Every row is loaded, so there is nothing more to offer.
    await page.getByRole("checkbox", { name: "Select all rows" }).check();
    await text(page, "Selected: 2").waitFor();
    await page.waitForTimeout(300);
    expect(await text(page, /loaded messages are selected/).count()).toBe(0);
  });

  test("keeps sent mail in Starred when Report spam runs on it", async () => {
    app.store.set(
      "mine",
      message("mine", PLAIN(7), "Mine", Date.now(), { direction: "out", starred: true }),
    );
    (app.store.get("note1")?.item as Record<string, unknown>).starred = true;
    const page = await open("/starred", `[data-message-row="mine"]`);
    await row(page, "note1").getByRole("checkbox").check();
    await row(page, "mine").getByRole("checkbox").check();
    await bar(page).getByRole("button", { name: "Report spam" }).click();
    await row(page, "note1").waitFor({ state: "detached" });
    expect(await row(page, "mine").count()).toBe(1);
    expect(app.store.get("mine")?.item.spam).toBe(false);
  });

  test("reports spam from the Inbox, never offers it in Sent, and Not spam brings it back", async () => {
    const page = await open("/", `[data-message-row="note1"]`);
    await row(page, "note1").getByRole("checkbox").check();
    await row(page, "note2").getByRole("checkbox").check();
    await bar(page).getByRole("button", { name: "Report spam" }).click();
    await row(page, "note1").waitFor({ state: "detached" });
    expect(app.patches.at(-1)).toEqual({
      path: "/api/messages",
      body: { ids: expect.arrayContaining(["note1", "note2"]), spam: true },
    });
    await text(page, "Moved to Spam (2)").waitFor();
    expect([...app.mailbox.senders.keys()]).toEqual(["sender@example.org"]);

    await page.goto(`${app.origin}/sent`);
    await bar(page).waitFor();
    expect(await bar(page).getByRole("button", { name: "Report spam" }).count()).toBe(0);

    await page.goto(`${app.origin}/spam`);
    await row(page, "note1").getByRole("checkbox").check();
    await bar(page).getByRole("button", { name: "Not spam" }).click();
    await row(page, "note1").waitFor({ state: "detached" });
    expect(app.patches.at(-1)).toEqual({ path: "/api/messages/note1", body: { spam: false } });
    expect(app.mailbox.senders.size).toBe(0);
    expect(app.store.get("note1")?.item).toMatchObject({ spam: false, archived: false });
  });

  test("reports spam from the reader", async () => {
    const page = await open("/?m=note1", "text=Plain note 1.");
    await page
      .getByRole("toolbar", { name: "Message actions" })
      .getByRole("button", { name: "Report spam" })
      .click();
    await row(page, "note1").waitFor({ state: "detached" });
    expect(app.patches.at(-1)).toEqual({ path: "/api/messages/note1", body: { spam: true } });
  });

  test("opens a Spam message without remote images and with the Spam actions", async () => {
    app.store.set("junk", message("junk", HOSTILE, "Junk", Date.now() + 1000, { spam: true }));
    const page = await open("/spam?m=junk", "iframe");
    await page.frameLocator("iframe").locator("#greeting").waitFor();
    const toolbar = page.getByRole("toolbar", { name: "Message actions" });
    await toolbar.getByRole("button", { name: "Not spam" }).waitFor();
    await toolbar.getByRole("button", { name: "Delete forever" }).waitFor();
    for (const name of ["Archive", "Move to Trash", "Report spam", "Show remote images"])
      expect([name, await page.getByRole("button", { name }).count()]).toEqual([name, 0]);
    await text(page, "Remote images are always blocked in Spam.").waitFor();
    const srcdoc = (await page.locator("iframe").getAttribute("srcdoc")) ?? "";
    expect(srcdoc).toContain("img-src data:;");
    expect(session?.remote).toEqual([]);
  });

  test("drops an Inbox row the consumer files into Spam and refreshes the open reader", async () => {
    const page = await open("/?m=hostile", "iframe");
    // Images the owner allowed in the Inbox stop loading once the message is in Spam.
    await page.getByRole("button", { name: "Show remote images" }).click();
    await page.waitForFunction(() =>
      document.querySelector("iframe")?.getAttribute("srcdoc")?.includes("img-src data: https:"),
    );
    const item = app.store.get("hostile")?.item as Record<string, unknown>;
    item.spam = true;
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "filed", id: "hostile" }));
    await row(page, "hostile").waitFor({ state: "detached" });
    const toolbar = page.getByRole("toolbar", { name: "Message actions" });
    await toolbar.getByRole("button", { name: "Not spam" }).waitFor();
    expect(await page.getByRole("button", { name: "Show remote images" }).count()).toBe(0);
    await page.waitForFunction(() =>
      document.querySelector("iframe")?.getAttribute("srcdoc")?.includes("img-src data:;"),
    );
    expect(await row(page, "note1").count()).toBe(1);
  });

  test("fetches a scroll page again from its cursor when a filed event discards it", async () => {
    fill("bulk", 60);
    const page = await open("/", `[data-message-row="note1"]`);
    const gate = await hold(
      page,
      (url, method) => isList(url, method) && url.searchParams.has("cursor"),
      true,
    );
    await row(page, "bulk40").scrollIntoViewIfNeeded();
    await until(() => gate.seen.length === 1);
    (app.store.get("note1")?.item as Record<string, unknown>).spam = true;
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "filed", id: "note1" }));
    await row(page, "note1").waitFor({ state: "detached" });
    gate.release();
    await row(page, "bulk59").waitFor();
    expect(gate.seen.length).toBe(2);
    expect(new URL(gate.seen[1] ?? "").searchParams.get("cursor")).toBe(
      new URL(gate.seen[0] ?? "").searchParams.get("cursor"),
    );
    expect(await row(page, "bulk59").count()).toBe(1);
  });

  test("shows the list when a filed event arrives during the first load", async () => {
    let first: Gate | undefined;
    let lists = 0;
    session = await openSession(app.origin, "/", {
      prepare: async (page) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        first = await hold(page, (url, method) => isList(url, method) && lists++ === 0);
      },
    });
    const page = session.page;
    await until(() => first?.seen.length === 1 && app.sockets.size > 0);
    (app.store.get("hostile")?.item as Record<string, unknown>).spam = true;
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "filed", id: "hostile" }));
    await until(() => lists >= 2);
    first?.release();
    await row(page, "note1").waitFor({ timeout: 5000 });
    expect(await row(page, "hostile").count()).toBe(0);
  });

  test("drops both rows when two filed events arrive close together", async () => {
    const page = await open("/", `[data-message-row="note1"]`);
    const detail = await hold(
      page,
      (url, method) => method === "GET" && url.pathname === "/api/messages/note1",
    );
    for (const id of ["note1", "hostile"]) {
      (app.store.get(id)?.item as Record<string, unknown>).spam = true;
    }
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "filed", id: "note1" }));
    await until(() => detail.seen.length === 1);
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "filed", id: "hostile" }));
    await row(page, "hostile").waitFor({ state: "detached" });
    detail.release();
    await row(page, "note1").waitFor({ state: "detached", timeout: 5000 });
    expect(await row(page, "note2").count()).toBe(1);
  });

  /**
   * Files note1, holds the re-read the event starts with its answer taken while note1 was in
   * Spam, then brings note1 back to the Inbox as Not spam from another device would.
   */
  async function staleReread(page: Page) {
    const detail = await hold(
      page,
      (url, method) => method === "GET" && url.pathname === "/api/messages/note1",
      true,
    );
    const note1 = app.store.get("note1")?.item as Record<string, unknown>;
    note1.spam = true;
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "filed", id: "note1" }));
    await until(() => detail.answered.length === 1);
    note1.spam = false;
    return async () => {
      const answer = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/messages/note1",
      );
      detail.release();
      await answer;
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 100))),
      );
    };
  }
  const listAnswer = (page: Page) =>
    page.waitForResponse((r) => isList(new URL(r.url()), r.request().method()));

  test("ignores a re-read begun before a refresh", async () => {
    const page = await open("/", `[data-message-row="note1"]`);
    const release = await staleReread(page);
    const reloaded = listAnswer(page);
    await page.getByRole("button", { name: "Refresh" }).first().click();
    await reloaded;
    await row(page, "note1").waitFor();
    await release();
    expect(await row(page, "note1").count()).toBe(1);
  });

  test("ignores a re-read begun before a whole-folder loop", async () => {
    fill("bulk", 60);
    const page = await open("/", `[data-message-row="note1"]`);
    const release = await staleReread(page);
    await page.getByRole("checkbox", { name: "Select all rows" }).first().check();
    await page.getByRole("button", { name: "Select all 65 in Inbox" }).click();
    const reloaded = listAnswer(page);
    await bar(page).getByRole("button", { name: "Mark as read" }).click();
    await reloaded;
    await row(page, "note1").waitFor();
    await release();
    expect(await row(page, "note1").count()).toBe(1);
  });
});

describe("Delete forever and Empty", () => {
  test("empties Trash after confirmation, with progress and the dialog's watermark", async () => {
    fill("gone", 250, { trashed: true });
    const page = await open("/trash", `[data-message-row="gone0"]`);
    const gate = await hold(page, (url, method) => isPurge(url, method) && purges().length >= 1);
    await page.getByRole("button", { name: "Empty Trash" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText("Empty Trash?").waitFor();
    await dialog
      .getByText("250 messages and their attachments are removed. This cannot be undone.")
      .waitFor();
    await dialog.getByRole("button", { name: "Empty Trash" }).click();
    await dialog.getByText("Deleted 100 of 250…").waitFor();
    await row(page, "gone0").waitFor({ state: "detached" });
    gate.release();
    await text(page, "Deleted forever (250)").waitFor();
    await dialog.waitFor({ state: "detached" });
    await text(page, "Trash is empty").waitFor();
    const count = app.mailbox.calls.find((c) => c.path.startsWith("/api/messages/count"));
    expect(count?.path).toBe("/api/messages/count?folder=trash");
    expect(purges().length).toBe(3);
    const bodies = purges().map((c) => c.body as Record<string, unknown>);
    for (const body of bodies) expect(body).toEqual(bodies[0] as Record<string, unknown>);
    expect(bodies[0]).toEqual({ folder: "trash", watermark: 255, asOf: expect.any(Number) });
  });

  test("stops between calls when cancelled, keeping what was deleted", async () => {
    fill("gone", 250, { trashed: true });
    const page = await open("/trash", `[data-message-row="gone0"]`);
    const gate = await hold(page, (url, method) => isPurge(url, method) && purges().length >= 1);
    await page.getByRole("button", { name: "Empty Trash" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Empty Trash" }).click();
    await dialog.getByText("Deleted 100 of 250…").waitFor();
    await dialog.getByRole("button", { name: "Stop" }).click();
    gate.release();
    await text(page, "Deleted forever (200)").waitFor();
    expect(purges().length).toBe(2);
    await row(page, "gone249").waitFor();
    expect(await page.locator("[data-message-row]").count()).toBe(50);
  });

  test("stops and refreshes the list when a call gets no answer", async () => {
    fill("gone", 250, { trashed: true });
    const page = await open("/trash", `[data-message-row="gone0"]`);
    let calls = 0;
    await page.route(
      (url) => url.pathname === "/api/messages/purge",
      (route) => (++calls === 2 ? route.abort("failed") : route.fallback()),
    );
    const lists = await hold(page, isList, false);
    lists.release();
    await page.getByRole("button", { name: "Empty Trash" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Empty Trash" }).click();
    await text(
      page,
      "The connection was lost, so whether the last change was saved is unknown. The list was refreshed.",
    ).waitFor();
    expect(calls).toBe(2);
    expect(purges().length).toBe(1);
    // The failed fetch also marks the app offline; coming back online reloads the page again.
    await until(() => lists.seen.length >= 1);
    await row(page, "gone100").waitFor();
    expect(await row(page, "gone99").count()).toBe(0);
  });

  test("starts no list fetch during the loop and lets none begun before it bring rows back", async () => {
    fill("gone", 130, { trashed: true });
    const page = await open("/trash", `[data-message-row="gone0"]`);
    // A refresh begun before the loop, its answer held until the loop is half done.
    let lists0 = 0;
    const before = await hold(page, (url, method) => isList(url, method) && lists0++ === 0, true);
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "changed", id: "gone0" }));
    await until(() => before.seen.length === 1);
    const purge = await hold(page, (url, method) => isPurge(url, method) && purges().length >= 1);
    const lists: string[] = [];
    page.on("request", (r) => {
      if (isList(new URL(r.url()), r.method())) lists.push(r.url());
    });
    await page.getByRole("button", { name: "Empty Trash" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Empty Trash" }).click();
    await until(() => purge.seen.length === 1);
    await row(page, "gone0").waitFor({ state: "detached" });
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "message", id: "gone1" }));
    await page.waitForTimeout(300);
    expect(lists).toEqual([]);
    expect(await page.getByRole("button", { name: "Refresh" }).isDisabled()).toBe(true);
    // The old answer lands mid-loop and must not bring the deleted rows back.
    before.release();
    await page.waitForTimeout(300);
    expect(await row(page, "gone0").count()).toBe(0);
    purge.release();
    await text(page, "Deleted forever (130)").waitFor();
    await page.waitForTimeout(300);
    expect(lists.length).toBe(1);
    expect(await page.locator("[data-message-row]").count()).toBe(0);
    await text(page, "Trash is empty").waitFor();
  });

  test("deletes the selection forever and drops only what the server deleted", async () => {
    fill("gone", 3, { trashed: true });
    const page = await open("/trash", `[data-message-row="gone0"]`);
    await row(page, "gone0").getByRole("checkbox").check();
    await row(page, "gone1").getByRole("checkbox").check();
    // Restored on another device before the delete: the server skips it.
    (app.store.get("gone1")?.item as Record<string, unknown>).trashed = false;
    await bar(page).getByRole("button", { name: "Delete forever" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText("Delete 2 messages forever?").waitFor();
    await dialog.getByRole("button", { name: "Delete forever" }).click();
    await text(page, "Deleted forever (1)").waitFor();
    expect(app.mailbox.calls.find((c) => c.method === "DELETE")?.body).toEqual({
      folder: "trash",
      ids: ["gone0", "gone1"],
    });
    expect(app.store.has("gone1")).toBe(true);
    await row(page, "gone0").waitFor({ state: "detached" });
    expect(await row(page, "gone2").count()).toBe(1);
  });
});

describe("Delete forever on a whole folder", () => {
  test("purges all of Spam selected with select all, with the count it was entered with", async () => {
    fill("junk", 60, { spam: true });
    const page = await open("/spam", `[data-message-row="junk0"]`);
    await page.getByRole("checkbox", { name: "Select all rows" }).check();
    await page.getByRole("button", { name: "Select all 60 in Spam" }).click();
    // Filed after the mode was entered: shown, not deleted.
    app.store.set("late", message("late", PLAIN(98), "Late", Date.now() + 5000, { spam: true }));
    await bar(page).getByRole("button", { name: "Delete forever" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText("Delete 60 messages forever?").waitFor();
    await dialog.getByRole("button", { name: "Delete forever" }).click();
    await text(page, "Deleted forever (60)").waitFor();
    expect(purges().map((c) => c.body)).toEqual([
      { folder: "spam", watermark: 65, asOf: expect.any(Number) },
    ]);
    expect(app.mailbox.calls.filter((c) => c.path.startsWith("/api/messages/count")).length).toBe(
      1,
    );
    await row(page, "late").waitFor();
    expect(await page.locator("[data-message-row]").count()).toBe(1);
  });
});

describe("Select all matching", () => {
  test("offers all N, then archives the whole folder over several calls", async () => {
    fill("bulk", 120);
    app.mailbox.folderPatchMax = 50;
    const page = await open("/", `[data-message-row="note1"]`);
    // Desktop keeps the column header row, which holds select all.
    expect(await page.getByRole("columnheader", { name: "Message" }).count()).toBe(1);
    await page.getByRole("checkbox", { name: "Select all rows" }).first().check();
    await text(page, "All 50 loaded messages are selected.").waitFor();
    await page.getByRole("button", { name: "Select all 125 in Inbox" }).click();
    await text(page, "All 125 messages in Inbox are selected.").waitFor();
    // Mail that arrives now is shown but not included.
    app.store.set("late", message("late", PLAIN(99), "Late", Date.now() + 5000));
    for (const ws of app.sockets) ws.send(JSON.stringify({ type: "message", id: "late" }));
    await row(page, "late").waitFor();
    await text(page, "All 125 messages in Inbox are selected.").waitFor();
    await bar(page).getByRole("button", { name: "Archive" }).click();
    await text(page, "Archived (125)").waitFor();
    const patches = app.patches.filter((p) => p.body.folder === "inbox");
    expect(patches.map((p) => p.body)).toEqual([
      { folder: "inbox", watermark: 125, archived: true },
      { folder: "inbox", watermark: 125, after: expect.any(Number), archived: true },
      { folder: "inbox", watermark: 125, after: expect.any(Number), archived: true },
    ]);
    expect(app.store.get("late")?.item.archived).toBe(false);
    await row(page, "late").waitFor();
    expect(await page.locator("[data-message-row]").count()).toBe(1);
  });

  test("labels Report spam Move to Spam in whole-folder mode and learns no sender", async () => {
    fill("bulk", 60);
    const page = await open("/", `[data-message-row="note1"]`);
    await page.getByRole("checkbox", { name: "Select all rows" }).check();
    await bar(page).getByRole("button", { name: "Report spam" }).waitFor();
    await page.getByRole("button", { name: "Select all 65 in Inbox" }).click();
    expect(await bar(page).getByRole("button", { name: "Report spam" }).count()).toBe(0);
    await bar(page).getByRole("button", { name: "Move to Spam" }).click();
    await text(page, "Moved to Spam (65)").waitFor();
    expect(app.patches.at(-1)?.body).toEqual({ folder: "inbox", watermark: 65, spam: true });
    expect(app.mailbox.senders.size).toBe(0);
  });

  test("leaves whole-folder mode when a row is unchecked or the folder changes", async () => {
    fill("bulk", 60);
    const page = await open("/", `[data-message-row="note1"]`);
    await page.getByRole("checkbox", { name: "Select all rows" }).first().check();
    await page.getByRole("button", { name: "Select all 65 in Inbox" }).click();
    await text(page, "All 65 messages in Inbox are selected.").waitFor();
    await row(page, "note1").getByRole("checkbox").uncheck();
    await text(page, "All 65 messages in Inbox are selected.").waitFor({ state: "detached" });
    expect(await text(page, "Selected: 49").count()).toBe(1);
    await row(page, "note1").getByRole("checkbox").check();
    await page.getByRole("button", { name: "Select all 65 in Inbox" }).click();
    await page.getByRole("link", { name: /^Archive/ }).click();
    await page.waitForURL("**/archive");
    await text(page, "No archived messages").waitFor();
    expect(await text(page, /messages in Inbox are selected/).count()).toBe(0);
  });

  test("leaves whole-folder mode when the address view changes", async () => {
    fill("bulk", 60);
    session = await openSession(app.origin, "/address/1", {
      prepare: async (page) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.route(`${app.origin}/api/addresses`, (route) =>
          route.fulfill({
            json: {
              addresses: [
                { id: 1, address: "shop@example.com", targetIds: [] },
                { id: 2, address: "news@example.com", targetIds: [] },
              ],
            },
          }),
        );
      },
    });
    const page = session.page;
    await row(page, "note1").waitFor();
    await page.getByRole("checkbox", { name: "Select all rows" }).check();
    await page.getByRole("button", { name: "Select all 65 in shop@example.com" }).click();
    await text(page, "All 65 messages in shop@example.com are selected.").waitFor();
    // Mark read runs over the folder; the view changes while its call is held.
    app.mailbox.folderPatchMax = 20;
    const patch = await hold(
      page,
      (url, method) => method === "PATCH" && url.pathname === "/api/messages",
    );
    const lists: string[] = [];
    page.on("request", (r) => {
      if (isList(new URL(r.url()), r.method())) lists.push(r.url());
    });
    await bar(page).getByRole("button", { name: "Mark as read" }).click();
    await until(() => patch.seen.length === 1);
    await page.getByRole("link", { name: "news@example.com" }).click();
    await page.waitForURL("**/address/2");
    await page.waitForTimeout(300);
    expect(lists).toEqual([]);
    patch.release();
    await text(page, "No mail yet").waitFor();
    // The loop stopped after the call in flight, and the new view loaded once.
    expect(patch.seen.length).toBe(1);
    expect(lists.length).toBe(1);
    expect(new URL(lists[0] ?? "").searchParams.get("address")).toBe("2");
    expect(await text(page, /are selected/).count()).toBe(0);
    await page.getByRole("link", { name: /^shop@example.com/ }).click();
    await row(page, "note1").waitFor();
    expect(await text(page, /are selected/).count()).toBe(0);
  });
});
