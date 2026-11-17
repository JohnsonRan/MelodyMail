import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import { message, StubApp } from "./stub-app";

// The app on a phone (iPhone 16 Pro: 402 x 874 CSS px) with a coarse pointer, through the built
// app in Chromium: touch targets (REQUIREMENTS.md, "Touch target, coarse pointer"), long values
// on narrow rows, the compact reader and list actions, the drawer, and the browser bar colour.

const PHONE = { width: 402, height: 874 };
const LONG = "very.long.local.part.for.testing@subdomain.extremely-long-domain-name-example.org";
// Longer than LONG: a phone cut this one at the right edge of the reader.
const SENDER =
  "very.long.local.part.for.testing.wrapping.behaviour@subdomain.extremely-long-domain-name-example.org";
const LONG_MAIL = [
  `From: Newsletter <${SENDER}>`,
  "To: shop@example.com",
  "Subject: Long sender",
  "Message-ID: <long@example.org>",
  "",
  "Hello.",
  "",
].join("\r\n");
const ADDRESSES = [
  { id: 1, address: "shop@example.com", note: "Main", enabled: true },
  { id: 2, address: LONG, note: "", enabled: false },
].map((a) => ({
  localPart: a.address.split("@")[0],
  domain: a.address.split("@")[1],
  displayName: "",
  forwardOnly: false,
  targetIds: [],
  lastReceivedAt: null,
  createdAt: 0,
  ...a,
}));

let app: StubApp;
let s: Session;

beforeAll(async () => {
  app = new StubApp();
  app.store.set(
    "long",
    message("long", LONG_MAIL, "Long sender", Date.now() + 1000, {
      from: `Newsletter <${SENDER}>`,
    }),
  );
  s = await openSession(app.origin, "/", { touch: PHONE });
  // Settings > Addresses with a long address; the stand-in knows only shop@example.com.
  const settings: Record<string, unknown> = {
    addresses: { addresses: ADDRESSES },
    domains: { domains: [] },
    "forward-targets": { targets: [] },
  };
  for (const [path, json] of Object.entries(settings)) {
    await s.page.route(`${app.origin}/api/${path}`, (route) =>
      route.request().method() === "GET" ? route.fulfill({ json }) : route.fallback(),
    );
  }
  await s.page.reload();
  await s.page.locator(`[data-message-row="note3"]`).waitFor();
});

afterAll(async () => {
  await s.page.context().close();
  await shutdown();
  await app.stop();
});

const go = async (path: string, ready: string) => {
  await s.page.goto(`${app.origin}${path}`);
  await s.page.locator(ready).first().waitFor();
};

const rect = (selector: ReturnType<Session["page"]["locator"]>) =>
  selector.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });

describe("phone end to end", () => {
  test("keeps the app name whole, with language and theme in the drawer", async () => {
    await go("/", `[data-message-row="note3"]`);
    const bar = s.page.getByRole("navigation", { name: "Main navigation" });
    expect(await bar.getByRole("combobox").count()).toBe(0);
    const name = bar.getByText("MelodyMail", { exact: true });
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await s.page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = s.page.getByRole("dialog");
    await drawer.getByRole("combobox", { name: "Language" }).waitFor();
    expect(await drawer.getByRole("combobox", { name: "Theme" }).count()).toBe(1);
    await s.page.keyboard.press("Escape");
  });

  test("lists the settings sections at /settings", async () => {
    await go("/settings", "text=API keys");
    expect(s.page.url()).toBe(`${app.origin}/settings`);
    expect(await s.page.locator(".astryx-list-item").count()).toBe(7);
    const main = s.page.getByRole("main");
    expect(await main.getByRole("heading", { level: 1 }).textContent()).toBe("Settings");
    expect(await main.getByRole("link").allTextContents()).toEqual([
      "Domains",
      "Addresses",
      "Forwarding",
      "Rules",
      "Notifications",
      "Security",
      "API keys",
    ]);
    // The whole row is the link: a tap at its start, away from the label, opens the section.
    const row = await rect(s.page.locator(".astryx-list-item").filter({ hasText: "Rules" }));
    await s.page.touchscreen.tap(row.left + 2, row.top + 2);
    await s.page.waitForURL("**/settings/rules");
  });
});
