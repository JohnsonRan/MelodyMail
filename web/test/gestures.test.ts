import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import {
  go as goTo,
  LONG_MAIL,
  line,
  PHONE,
  rect,
  rowPoint,
  touchChannel,
  touchGesture,
} from "./phone";
import { message, StubApp } from "./stub-app";

// The phone list's touch gestures (iPhone 16 Pro: 402 x 874 CSS px, coarse pointer) through the
// built app in Chromium: long press into selection mode, a vertical drag left to scrolling, and
// the swipe actions on a row. Split from mobile.test.ts by M8 owner ruling 7 (2026-11-19) and run
// by `bun run test:folders`.

let app: StubApp;
let s: Session;

beforeAll(async () => {
  app = new StubApp();
  s = await openSession(app.origin, "/", { touch: PHONE });
  await s.page.locator(`[data-message-row="note3"]`).waitFor();
});

afterAll(async () => {
  await s.page.context().close();
  await shutdown();
  await app.stop();
});

const go = (path: string, ready: string) => goTo(s.page, app.origin, path, ready);

describe("phone long press", () => {
  const checkboxes = () => s.page.locator("[data-select-cell]");
  const bulkBar = () => s.page.getByRole("toolbar", { name: "Actions on selected messages" });

  test("enters selection mode on a long press, and a press never opens the row", async () => {
    await go("/", `[data-message-row="note3"]`);
    const point = await rowPoint(s.page, "note1");
    await touchGesture(s.page, [point, point], { holdMs: 700 });
    await s.page.getByText("Selected: 1").waitFor();
    await bulkBar().waitFor();
    // The click that follows the release must not toggle the row it just selected.
    await s.page.waitForTimeout(100);
    await s.page.getByText("Selected: 1").waitFor();
    expect(s.page.url()).toBe(`${app.origin}/`);
    expect(
      await s.page.locator(`[data-message-row="note1"] input[type=checkbox]`).isChecked(),
    ).toBe(true);
  });

  test("leaves a vertical drag to scrolling: no swipe, no selection", async () => {
    await go("/", `[data-message-row="note3"]`);
    const patches = app.patches.length;
    const from = await rowPoint(s.page, "note1");
    // Slower than the long-press time, so only the movement keeps the timer from firing.
    await touchGesture(s.page, line(from, { x: from.x, y: from.y - 120 }, 6), { stepMs: 120 });
    await s.page.waitForTimeout(200);
    expect(await bulkBar().count()).toBe(0);
    expect(await checkboxes().count()).toBe(0);
    expect(s.page.url()).toBe(`${app.origin}/`);
    expect(app.patches.length).toBe(patches);
  });
});

describe("phone swipe", () => {
  const bulkBar = () => s.page.getByRole("toolbar", { name: "Actions on selected messages" });

  /** Adds a row to the stand-in and opens `path`, where it shows. */
  async function withRow(id: string, path: string, flags: Record<string, unknown> = {}) {
    app.store.set(id, message(id, LONG_MAIL, `Swipe ${id}`, Date.now() + 5000, flags));
    await go(path, `[data-message-row="${id}"]`);
  }

  /** Swipes a row by `dx` px (right is positive) and returns the style values it showed. */
  async function swipe(id: string, dx: number) {
    const row = s.page.locator(`[data-message-row="${id}"]`);
    await row.evaluate((el, rowId) => {
      const win = window as unknown as { seen?: Record<string, string[]> };
      const store = win.seen ?? {};
      win.seen = store;
      const log: string[] = [];
      store[rowId] = log;
      new MutationObserver(() => log.push(el.getAttribute("style") ?? "")).observe(el, {
        attributes: true,
        attributeFilter: ["style"],
      });
    }, id);
    const from = await rowPoint(s.page, id);
    const start = { x: dx > 0 ? 40 : 360, y: from.y };
    await touchGesture(s.page, line(start, { x: start.x + dx, y: start.y }, 10), { stepMs: 16 });
    return row;
  }

  const seen = (id: string) =>
    s.page.evaluate(
      (rowId) => (window as unknown as { seen?: Record<string, string[]> }).seen?.[rowId] ?? [],
      id,
    );

  const patched = () => app.patches.at(-1);

  test("archives the row on a swipe right past 40% of its width", async () => {
    await withRow("sw1", "/");
    const before = app.patches.length;
    const row = await swipe("sw1", 280);
    await row.waitFor({ state: "detached" });
    expect(app.patches.length).toBe(before + 1);
    expect(patched()).toEqual({ path: "/api/messages/sw1", body: { archived: true } });
    // A swipe never opens the row or starts selection mode.
    expect(s.page.url()).toBe(`${app.origin}/`);
    expect(await bulkBar().count()).toBe(0);
  });

  test("moves the row to Trash on a swipe left", async () => {
    await withRow("sw2", "/");
    const row = await swipe("sw2", -280);
    await row.waitFor({ state: "detached" });
    expect(patched()).toEqual({ path: "/api/messages/sw2", body: { trashed: true } });
    expect(s.page.url()).toBe(`${app.origin}/`);
  });

  test("springs back, and runs nothing, when released before the arm point", async () => {
    await withRow("sw3", "/");
    const before = app.patches.length;
    const row = await swipe("sw3", 100);
    await s.page.waitForFunction((id) => {
      const el = document.querySelector(`[data-message-row="${id}"]`) as HTMLElement | null;
      return el !== null && el.style.transform === "";
    }, "sw3");
    expect(app.patches.length).toBe(before);
    expect(await row.count()).toBe(1);
    // Safari may send the click that follows a drag; it must not open the row.
    await row.evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await s.page.waitForTimeout(100);
    expect(s.page.url()).toBe(`${app.origin}/`);
    expect(await bulkBar().count()).toBe(0);
  });

  test("keeps the list where it is while a row is held mid-swipe", async () => {
    await withRow("sw8", "/");
    const list = s.page.locator(".astryx-table-scroll-wrapper");
    const before = await rect(list);
    const from = await rowPoint(s.page, "sw8");
    const { send, detach } = await touchChannel(s.page);
    await send("touchStart", [{ x: 40, y: from.y }]);
    for (const x of [60, 100, 160, 240]) await send("touchMove", [{ x, y: from.y }]);
    await s.page.locator(".mail-swipe-backdrop").waitFor();
    const during = await rect(list);
    await send("touchEnd", []);
    await detach();
    expect(during.top).toBe(before.top);
    await s.page.waitForFunction(
      (id) => document.querySelector(`[data-message-row="${id}"]`) === null,
      "sw8",
    );
  });

  /**
   * Holds a swipe of `dx` px past the arm point and returns what the backdrop shows, next to the
   * theme's own colours, then lets the swipe go.
   */
  async function armedColours(id: string, path: string, dx: number, flags = {}) {
    await withRow(id, path, flags);
    const from = await rowPoint(s.page, id);
    const x0 = dx > 0 ? 40 : 360;
    const { send, detach } = await touchChannel(s.page);
    await send("touchStart", [{ x: x0, y: from.y }]);
    for (const step of [0.25, 0.5, 0.75, 1]) {
      await send("touchMove", [{ x: x0 + dx * step, y: from.y }]);
    }
    await s.page.locator(`.mail-swipe-backdrop[data-armed="true"]`).waitFor();
    const found = await s.page.evaluate(() => {
      const paint = (name: string, property: "backgroundColor" | "color") => {
        const probe = document.createElement("div");
        probe.style[property] = `var(${name})`;
        document.body.append(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      };
      const backdrop = getComputedStyle(document.querySelector(".mail-swipe-backdrop") as Element);
      return {
        background: backdrop.backgroundColor,
        color: backdrop.color,
        success: {
          background: paint("--color-success", "backgroundColor"),
          color: paint("--color-on-success", "color"),
        },
        error: {
          background: paint("--color-error", "backgroundColor"),
          color: paint("--color-on-error", "color"),
        },
      };
    });
    await send("touchEnd", []);
    await detach();
    await s.page.waitForFunction(
      (rowId) => document.querySelector(`[data-message-row="${rowId}"]`) === null,
      id,
    );
    return found;
  }

  test("paints an armed right swipe green and an armed left swipe red, light and dark", async () => {
    for (const mode of ["light", "dark"]) {
      await s.page.evaluate((m) => localStorage.setItem("melodymail.mode", m), mode);
      const archive = await armedColours(`${mode}-a`, "/", 240);
      expect([mode, archive.background, archive.color]).toEqual([
        mode,
        archive.success.background,
        archive.success.color,
      ]);
      const trash = await armedColours(`${mode}-t`, "/", -240);
      expect([mode, trash.background, trash.color]).toEqual([
        mode,
        trash.error.background,
        trash.error.color,
      ]);
      const restore = await armedColours(`${mode}-r`, "/trash", 240, { trashed: true });
      expect([mode, restore.background]).toEqual([mode, restore.success.background]);
      const notSpam = await armedColours(`${mode}-n`, "/spam", 240, { spam: true });
      expect([mode, notSpam.background]).toEqual([mode, notSpam.success.background]);
    }
    await s.page.evaluate(() => localStorage.removeItem("melodymail.mode"));
  });

  test("slides the row with motion and not at all under reduced motion", async () => {
    await withRow("sw4", "/");
    const row = await swipe("sw4", 280);
    await row.waitFor({ state: "detached" });
    expect((await seen("sw4")).some((v) => v.includes("transition: transform"))).toBe(true);
    await s.page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await withRow("sw5", "/");
      const reduced = await swipe("sw5", 280);
      await reduced.waitFor({ state: "detached" });
      expect((await seen("sw5")).some((v) => v.includes("transition: transform"))).toBe(false);
      expect(patched()).toEqual({ path: "/api/messages/sw5", body: { archived: true } });
    } finally {
      await s.page.emulateMedia({ reducedMotion: "no-preference" });
    }
  });

  test("moves a row in Archive to the Inbox and one in Trash back, and never deletes", async () => {
    await withRow("sw6", "/archive", { archived: true });
    const archived = await swipe("sw6", 280);
    await archived.waitFor({ state: "detached" });
    expect(patched()).toEqual({ path: "/api/messages/sw6", body: { archived: false } });

    await withRow("sw7", "/trash", { trashed: true });
    const beforeTrash = app.patches.length;
    const trashLeft = await swipe("sw7", -280);
    await s.page.waitForTimeout(500);
    expect(await trashLeft.count()).toBe(1);
    expect(app.patches.length).toBe(beforeTrash);
    const restored = await swipe("sw7", 280);
    await restored.waitFor({ state: "detached" });
    expect(patched()).toEqual({ path: "/api/messages/sw7", body: { trashed: false } });
  });

  test("marks a row in Spam not spam on a swipe right, and does nothing on a swipe left", async () => {
    await withRow("sw9", "/spam", { spam: true });
    const before = app.patches.length;
    const left = await swipe("sw9", -280);
    await s.page.waitForTimeout(500);
    expect(await left.count()).toBe(1);
    expect(app.patches.length).toBe(before);
    const right = await swipe("sw9", 280);
    await right.waitFor({ state: "detached" });
    expect(patched()).toEqual({ path: "/api/messages/sw9", body: { spam: false } });
  });
});
