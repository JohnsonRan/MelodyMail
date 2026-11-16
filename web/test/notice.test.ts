import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { openSession, type Session, shutdown } from "./browser";
import { message, PLAIN, StubApp } from "./stub-app";

// The foreground reports and the in-page notice (docs/M5c-foreground.md) through the built app.
// Headless Chromium treats every page as visible and focused, so each page gets a switch for
// both, and a test flips it and fires the event a real tab or window switch would fire.

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

type Focus = { visible: boolean; focused: boolean };

/** Opens the inbox. With `clock`, the page runs on Playwright's clock in a context of its own,
 * so its 1 s re-check and 30 s refresh fire only when a test moves the clock. */
async function open(clock = false): Promise<Page> {
  session = await openSession(app.origin, "/", {
    isolated: clock,
    prepare: async (page) => {
      if (clock) await page.clock.install();
      await page.addInitScript(() => {
        const state = { visible: true, focused: true };
        (window as unknown as { focusState: Focus }).focusState = state;
        Object.defineProperty(document, "visibilityState", {
          get: () => (state.visible ? "visible" : "hidden"),
        });
        document.hasFocus = () => state.focused;
      });
    },
  });
  const { page } = session;
  await page.locator(`[data-message-row="note3"]`).waitFor();
  await waitForReports(["fg"]);
  return page;
}

/** Sets the page's visibility and focus, then fires `event` as the browser would. */
async function switchTo(page: Page, state: Focus, event: "visibilitychange" | "focus" | "blur") {
  await page.evaluate(
    ({ state, event }) => {
      Object.assign((window as unknown as { focusState: Focus }).focusState, state);
      (event === "visibilitychange" ? document : window).dispatchEvent(new Event(event));
    },
    { state, event },
  );
}

async function waitForReports(expected: string[]) {
  for (let i = 0; i < 150 && app.reports.length < expected.length; i++) await Bun.sleep(20);
  expect(app.reports).toEqual(expected);
}

function newMail(id: string, subject: string) {
  app.store.set(id, message(id, PLAIN(9), subject, Date.now() + 1000));
  for (const ws of app.sockets) ws.send(JSON.stringify({ type: "message", id }));
}

/** The mail cards: toasts of the theme's "mail" type (src/themes/melody/melodyTheme.ts). */
const notices = (page: Page) => page.locator('.astryx-toast[data-type="mail"]');

describe("foreground reports", () => {
  test("follow visibility and focus, once per change, and start again on a new socket", async () => {
    const page = await open(true);
    await page.clock.pauseAt(Date.now() + 500);
    await switchTo(page, { visible: false, focused: true }, "visibilitychange");
    await switchTo(page, { visible: true, focused: true }, "visibilitychange");
    await switchTo(page, { visible: true, focused: false }, "blur");
    await switchTo(page, { visible: true, focused: true }, "focus");
    await switchTo(page, { visible: true, focused: false }, "blur");
    // Already background: hiding the blurred page sends nothing more.
    await switchTo(page, { visible: false, focused: false }, "visibilitychange");
    await switchTo(page, { visible: true, focused: true }, "focus");
    const reports = ["fg", "bg", "fg", "bg", "fg", "bg", "fg"];
    await waitForReports(reports);
    // A reconnect opens a socket the Hub knows nothing about; the page reports on it again.
    for (const ws of app.sockets) ws.close();
    await page.waitForTimeout(100);
    await page.clock.runFor(1_000);
    await waitForReports([...reports, "fg"]);
  });

  test("notice the focus leaving from inside the reader frame without any top-level event", async () => {
    const page = await open();
    await page.locator(`[data-message-row="hostile"]`).click();
    const frame = page.locator("iframe").first();
    await frame.waitFor();
    // The owner clicks into the HTML message, then switches to another app: only the frame's window
    // blurs, so the top document sees no blur and no visibilitychange.
    await page.frameLocator("iframe").first().locator("body").click();
    await page.evaluate(() => {
      (window as unknown as { focusState: Focus }).focusState.focused = false;
    });
    await waitForReports(["fg", "bg"]);
  });

  test("repeat fg every 30 s while the page stays in the foreground, and only then", async () => {
    const page = await open(true);
    await page.clock.fastForward(29_000);
    await page.waitForTimeout(100);
    expect(app.reports).toEqual(["fg"]);
    await page.clock.fastForward(1_500);
    await waitForReports(["fg", "fg"]);
    // A background page does not repeat itself.
    await switchTo(page, { visible: true, focused: false }, "blur");
    await page.clock.fastForward(31_000);
    await page.waitForTimeout(100);
    expect(app.reports).toEqual(["fg", "fg", "bg"]);
  });
});

describe("new mail notice", () => {
  test("names sender and subject, not the body, is polite, keeps focus, and Open opens it", async () => {
    const page = await open();
    const search = page.locator(`[data-message-row="note3"]`).getByRole("checkbox");
    await search.focus();
    newMail("fresh", "Lunch on Friday?");
    const notice = notices(page).filter({ hasText: "Lunch on Friday?" });
    await notice.waitFor();
    expect(await notice.locator(".astryx-text").allTextContents()).toEqual([
      "Sender",
      "Lunch on Friday?",
    ]);
    const text = (await notice.textContent()) ?? "";
    expect(text).not.toContain("snippet");
    expect(text).not.toContain("Plain note");
    // Announced through a polite live region, never the assertive one.
    const live = (level: string) =>
      page
        .locator(`[aria-live="${level}"]`)
        .evaluateAll((els) => els.map((e) => e.textContent ?? "").join("|"));
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[aria-live="polite"]')].some((e) =>
        /New mail\s*Sender\s*Lunch on Friday\?/.test(e.textContent ?? ""),
      ),
    );
    expect(await live("assertive")).not.toContain("Lunch on Friday?");
    expect(await search.evaluate((e) => e === document.activeElement)).toBe(true);
    await notice.getByRole("button", { name: "Open" }).click();
    await page.waitForURL((url) => url.searchParams.get("m") === "fresh");
    // Open dismisses it; auto-hide would take 5 s.
    await notice.waitFor({ state: "detached", timeout: 2000 });
  });

  test("stays away while the page is hidden or blurred, and shows three at most", async () => {
    const page = await open();
    await switchTo(page, { visible: true, focused: false }, "blur");
    newMail("away", "Sent while away");
    await page.locator(`[data-message-row="away"]`).waitFor();
    await page.waitForTimeout(300);
    expect(await notices(page).count()).toBe(0);
    await switchTo(page, { visible: true, focused: true }, "focus");
    newMail("bare", "");
    await notices(page).filter({ hasText: "(no subject)" }).waitFor();
    for (const n of [1, 2, 3, 4]) newMail(`burst${n}`, `Burst ${n}`);
    // The four fetches finish in any order; whichever notice came first leaves.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.astryx-toast[data-type="mail"]')].filter((e) =>
          e.textContent?.includes("Burst"),
        ).length === 3,
      undefined,
      { timeout: 3000 },
    );
    await page.waitForTimeout(300);
    expect(await notices(page).count()).toBe(3);
    // The card draws its own close control, which dismisses it.
    await notices(page).first().getByRole("button", { name: "Close" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.astryx-toast[data-type="mail"]').length === 2,
      undefined,
      { timeout: 2000 },
    );
  });
});

describe("quiet setting", () => {
  test("is off at first, and the switch stores the change for every device", async () => {
    session = await openSession(app.origin, "/settings/notifications");
    const toggle = session.page.getByRole("switch", { name: "Quiet while MelodyMail is open" });
    await toggle.waitFor();
    expect(await toggle.isChecked()).toBe(false);
    await session.page
      .getByText("No system notification and no Telegram message is sent while")
      .waitFor();
    await toggle.click();
    const saved = session.page.locator(".astryx-toast").filter({ hasText: "Setting saved." });
    await saved.waitFor();
    // The mail card sits on the page's light surface; the ordinary toast stays inverted (dark).
    newMail("beside", "Next to a saved toast");
    const card = notices(session.page).filter({ hasText: "Next to a saved toast" });
    await card.waitFor();
    const lightness = (bg: string) => {
      const [r = 0, g = 0, b = 0] = bg.match(/\d+/g)?.map(Number) ?? [];
      return (r + g + b) / 3;
    };
    const bgOf = (l: typeof card) => l.evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(lightness(await bgOf(card))).toBeGreaterThan(200);
    expect(lightness(await bgOf(saved))).toBeLessThan(60);
    expect(app.quiet).toBe(true);
    expect(await toggle.isChecked()).toBe(true);
    await session.page.reload();
    await toggle.waitFor();
    expect(await toggle.isChecked()).toBe(true);
  });
});
