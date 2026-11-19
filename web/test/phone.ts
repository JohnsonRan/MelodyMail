import type { Locator, Page } from "playwright";

// Shared by the phone suites (mobile.test.ts and gestures.test.ts): the iPhone 16 Pro viewport,
// a sample mail, and real touch input through the Chrome DevTools Protocol.

export const PHONE = { width: 402, height: 874 };
// Longer than the longest address in the settings rows: a phone cut this one at the right edge.
export const SENDER =
  "very.long.local.part.for.testing.wrapping.behaviour@subdomain.extremely-long-domain-name-example.org";
export const LONG_MAIL = [
  `From: Newsletter <${SENDER}>`,
  "To: shop@example.com",
  "Subject: Long sender",
  "Message-ID: <long@example.org>",
  "",
  "Hello.",
  "",
].join("\r\n");

export const go = async (page: Page, origin: string, path: string, ready: string) => {
  await page.goto(`${origin}${path}`);
  await page.locator(ready).first().waitFor();
};

export const rect = (selector: Locator) =>
  selector.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });

// A real touch through the browser (Chrome DevTools Protocol): it raises pointer events and
// honours touch-action, which page.touchscreen.tap does not cover for a drag or a hold.
export type Point = { x: number; y: number };

/** A touch input channel; `detach` ends it. */
export async function touchChannel(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  return {
    send: (type: "touchStart" | "touchMove" | "touchEnd", points: Point[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points }),
    detach: () => cdp.detach(),
  };
}

export async function touchGesture(page: Page, path: Point[], { holdMs = 0, stepMs = 0 } = {}) {
  const touch = await touchChannel(page);
  const [first, ...rest] = path;
  if (!first) return;
  await touch.send("touchStart", [first]);
  if (holdMs) await page.waitForTimeout(holdMs);
  for (const point of rest) {
    await touch.send("touchMove", [point]);
    if (stepMs) await page.waitForTimeout(stepMs);
  }
  await touch.send("touchEnd", []);
  await touch.detach();
}

/** Points from `from` to `to` in `steps` equal moves. */
export const line = (from: Point, to: Point, steps = 8): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  }));

/** The middle of a message row, clear of its selection cell. */
export async function rowPoint(page: Page, id: string): Promise<Point> {
  const box = await rect(page.locator(`[data-message-row="${id}"]`));
  return { x: box.left + 200, y: (box.top + box.bottom) / 2 };
}
