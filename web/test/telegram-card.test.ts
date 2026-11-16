import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Page } from "playwright";
import { blankPage, shutdown } from "./browser";

// The Telegram card (worker/src/telegram/card.html) in Chromium with a stand-in TelegramWidget,
// as the widgets guide's "A first look in a browser" describes (docs/M5b-telegram.md, "Proof").
// A browser draws more than a Telegram app; these tests check the card's logic, not its look.

const CARD = await Bun.file(join(import.meta.dir, "../../worker/src/telegram/card.html")).text();

let page!: Page;
afterAll(async () => {
  await page?.close();
  await shutdown();
});

/** JSON for an inline script: "<" escaped so a value cannot end the script element. */
const inline = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");

type Answer = { result?: string; code?: string };

/** Loads the card with this chat state, language and queued request answers. */
async function load(chatData: unknown, options: { language?: string; answers?: Answer[] } = {}) {
  // A new page per card: the card's top-level consts would clash in a reused document.
  await page?.close();
  page = await blankPage();
  const standIn = `<script>
    Object.defineProperty(navigator, "language", { get: () => ${inline(options.language ?? "en-US")} });
    window.calls = { request: [], openLink: [] };
    window.handlers = {};
    window.answers = ${inline(options.answers ?? [])};
    window.TelegramWidget = {
      chatData: ${inline(chatData === null ? null : JSON.stringify(chatData))},
      onEvent(type, fn) { window.handlers[type] = fn; },
      openLink(url) { window.calls.openLink.push(url); if (url === undefined) throw new TypeError("bad url"); },
      request(data) {
        window.calls.request.push(data);
        const a = window.answers.shift() || { result: null };
        return a.code ? Promise.reject(Object.assign(new Error("x"), { name: "WidgetRequestError", code: a.code }))
          : Promise.resolve({ result: a.result ?? null });
      },
    };
  </script>`;
  await page.setContent(`${standIn}${CARD}`);
}

const mail = {
  v: 1,
  f: "Alice",
  s: "Lunch?",
  t: "shop@example.com",
  u: "https://mail.test/?m=m1",
  r: 0,
  a: 0,
  st: 0,
};
const text = async (id: string) => (await page.locator(`#${id}`).textContent()) ?? "";
const calls = () =>
  page.evaluate(
    () => (window as unknown as { calls: { request: string[]; openLink: string[] } }).calls,
  );

describe("telegram card", () => {
  test("writes untrusted text as text", async () => {
    const hostile = `<img src=x onerror="window.ran=1">`;
    await load({ ...mail, f: hostile, s: `<script>window.ran=1</script>`, t: hostile });
    expect(await text("f")).toBe(hostile);
    expect(await text("s")).toBe("<script>window.ran=1</script>");
    expect(await text("t")).toBe(`To: ${hostile}`);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { ran?: number }).ran)).toBeUndefined();
  });

  test("sends the target value and redraws from the answer", async () => {
    await load(mail, {
      answers: [{ result: '{"r":1,"a":0,"st":0}' }, { result: '{"r":0,"a":0,"st":0}' }],
    });
    expect(await text("r")).toBe("Mark as read");
    await page.click("#r");
    await page.locator("#r", { hasText: "Mark as unread" }).waitFor();
    await page.click("#r");
    await page.locator("#r", { hasText: "Mark as read" }).waitFor();
    await page.click("#a");
    await page.click("#x");
    expect((await calls()).request).toEqual(["read:1", "read:0", "arch:1", "star:1"]);
  });

  test("maps each answer and error to its line", async () => {
    const cases: [Answer, string][] = [
      [{ result: '{"e":"unbound"}' }, "Telegram is no longer connected to MelodyMail."],
      [{ result: '{"e":"bad"}' }, "MelodyMail didn't answer. Try again."],
      [{ code: "RATE_LIMITED" }, "Too many taps. Wait a few seconds and try again."],
      [{ code: "TIMEOUT" }, "MelodyMail didn't answer. Try again."],
      [{ result: "not json" }, ""],
    ];
    for (const [answer, line] of cases) {
      await load(mail, { answers: [answer] });
      await page.click("#x");
      await page.waitForFunction(
        () => !(document.getElementById("x") as HTMLButtonElement).disabled,
      );
      expect(await text("m"), JSON.stringify(answer)).toBe(line);
    }
    await load(mail, { answers: [{ result: '{"e":"gone"}' }] });
    await page.click("#a");
    await page.locator("#m", { hasText: "This message was deleted in MelodyMail." }).waitFor();
    expect(await page.locator("#b").isVisible()).toBe(false);
    expect(await text("f")).toBe("");
  });

  test("redraws when the chat state changes and drops a deleted card's content", async () => {
    await load(mail);
    await page.evaluate(() => {
      const w = window as unknown as {
        TelegramWidget: { chatData: string };
        handlers: Record<string, () => void>;
      };
      w.TelegramWidget.chatData = JSON.stringify({
        v: 1,
        f: "Alice",
        s: null,
        t: "a@b",
        u: "https://x",
        r: 1,
        a: 1,
        st: 1,
      });
      w.handlers.chatDataChanged?.();
    });
    expect(await text("s")).toBe("(no subject)");
    expect([await text("r"), await text("a"), await text("x")]).toEqual([
      "Mark as unread",
      "Move to Inbox",
      "Remove star",
    ]);
    await load({ v: 1, g: 1 });
    expect(await text("m")).toBe("This message was deleted in MelodyMail.");
  });

  test("sends one request for a double tap", async () => {
    await load(mail);
    await page.evaluate(() => {
      const w = window as unknown as { TelegramWidget: { request: () => Promise<unknown> } };
      const record = (window as unknown as { calls: { request: string[] } }).calls.request;
      w.TelegramWidget.request = (data?: unknown) => {
        record.push(String(data));
        return new Promise(() => {});
      };
      document.getElementById("x")?.click();
      document.getElementById("x")?.click();
    });
    expect((await calls()).request).toEqual(["star:1"]);
    expect(await text("m")).toBe("Working…");
  });

  test("opens the app link and explains the test card without a request", async () => {
    await load(mail);
    await page.click("#o");
    expect((await calls()).openLink).toEqual(["https://mail.test/?m=m1"]);
    await load({
      v: 1,
      x: 1,
      f: "MelodyMail",
      s: "Test notification",
      t: null,
      u: "https://mail.test/",
    });
    await page.click("#r");
    expect(await text("m")).toBe("This is a test card. The buttons work on cards for real mail.");
    expect((await calls()).request).toEqual([]);
    await load({ v: 1 });
    await page.click("#o");
    expect(await text("m")).toBe("This link can't be opened.");
  });

  test("picks the locale from the first two letters and falls back to English", async () => {
    const want: [string, string][] = [
      ["zh-TW", "标记为已读"],
      ["ja", "既読にする"],
      ["fr-FR", "Mark as read"],
      ["", "Mark as read"],
    ];
    for (const [language, label] of want) {
      await load(mail, { language });
      expect(await text("r"), language).toBe(label);
    }
    // A string runs in the page's global scope, where the card's top-level const L lives.
    const keys = (await page.evaluate(
      'Object.values(L).map((l) => Object.keys(l).sort().join(","))',
    )) as string[];
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });
});
