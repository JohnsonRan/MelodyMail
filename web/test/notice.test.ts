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

async function open(): Promise<Page> {
  session = await openSession(app.origin);
  const { page } = session;
  await page.addInitScript(() => {
    const state = { visible: true, focused: true };
    (window as unknown as { focusState: Focus }).focusState = state;
    Object.defineProperty(document, "visibilityState", {
      get: () => (state.visible ? "visible" : "hidden"),
    });
    document.hasFocus = () => state.focused;
  });
  await page.reload();
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

const notices = (page: Page) => page.locator(".astryx-toast");

describe("foreground reports", () => {
  test("follow visibility and focus, once per change, and start again on a new socket", async () => {
    const page = await open();
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
    await waitForReports([...reports, "fg"]);
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
    const text = (await notice.textContent()) ?? "";
    expect(text).toContain("New mail from Sender: Lunch on Friday?");
    expect(text).not.toContain("snippet");
    expect(text).not.toContain("Plain note");
    // Announced through a polite live region, never the assertive one.
    const live = (level: string) =>
      page
        .locator(`[aria-live="${level}"]`)
        .evaluateAll((els) => els.map((e) => e.textContent ?? "").join("|"));
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[aria-live="polite"]')].some((e) =>
        e.textContent?.includes("Lunch on Friday?"),
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
    await notices(page).filter({ hasText: "New mail from Sender: (no subject)" }).waitFor();
    for (const n of [1, 2, 3, 4]) newMail(`burst${n}`, `Burst ${n}`);
    // The four fetches finish in any order; whichever notice came first leaves.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".astryx-toast")].filter((e) =>
          e.textContent?.includes("Burst"),
        ).length === 3,
      undefined,
      { timeout: 3000 },
    );
    await page.waitForTimeout(300);
    expect(await notices(page).count()).toBe(3);
  });
});
