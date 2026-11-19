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
// A newsletter laid out for 640 px: a fixed table, a 600 px picture, two fixed columns and a
// preformatted line, the shapes that ran off a phone's frame.
const NEWSLETTER = [
  "From: News <news@example.org>",
  "To: shop@example.com",
  "Subject: Wide newsletter",
  "Message-ID: <wide@example.org>",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<table width="640" style="width:640px" cellpadding="12"><tr><td>',
  '<p id="wide">Weekly digest</p>',
  '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="600" height="200" style="width:600px;height:200px">',
  '<table width="100%"><tr><td width="300" style="width:300px">Left</td><td width="300" style="width:300px">Right</td></tr></table>',
  `<pre>${"x".repeat(120)}</pre>`,
  "</td></tr></table>",
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
  app.store.set("wide", message("wide", NEWSLETTER, "Wide newsletter", Date.now() + 2000));
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

/**
 * Visible targets whose hit area is smaller than 44 x 44 CSS px. A field's target is its whole
 * frame (a tap anywhere in it focuses the input), a list row's checkbox is its selection cell,
 * and a list item's link is the whole row (Astryx's invisible anchor pattern). A smaller box is measured by where a tap still lands on it: Astryx grows a checkbox or a
 * switch under a coarse pointer with an invisible hit area around its press box.
 */
const measureTargets = () =>
  s.page.evaluate(() => {
    const small: string[] = [];
    const TARGETS =
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=checkbox], [role=switch], [role=tab], [role=menuitem], [role=option]";
    const targets = document.querySelectorAll(TARGETS);
    for (const el of targets) {
      const box =
        el.closest(
          ".astryx-selector, .astryx-tokenizer, .astryx-text-input, .astryx-text-area, [data-select-cell]",
        ) ??
        (el.matches("a") ? el.closest(".astryx-list-item") : null) ??
        el;
      const r = box.getBoundingClientRect();
      // Visually hidden inputs and the skip link: their visible control is checked instead.
      if (r.width <= 2 || r.height <= 2 || getComputedStyle(el).visibility === "hidden") continue;
      if (r.bottom <= 0 || r.top >= innerHeight) continue;
      if (r.width >= 44 && r.height >= 44) continue;
      // A press box counts only when it holds this one target (a checkbox, a switch), not a
      // group such as a segmented control's track.
      const box0 = el.closest("[data-astryx-press-box]");
      const press = box0 && box0.querySelectorAll(TARGETS).length === 1 ? box0 : null;
      const owns = (hit: Element | null) =>
        hit !== null && (box.contains(hit) || press?.contains(hit) === true);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const reach = (dx: number, dy: number) => {
        let d = 0;
        while (d < 30 && owns(document.elementFromPoint(cx + dx * (d + 1), cy + dy * (d + 1)))) d++;
        return d;
      };
      const width = reach(-1, 0) + reach(1, 0) + 1;
      const height = reach(0, -1) + reach(0, 1) + 1;
      if (width < 44 || height < 44) {
        const name = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30);
        small.push(`${el.tagName.toLowerCase()} "${name}" ${width}x${height}`);
      }
    }
    return small;
  });

/** The small targets once layout has settled: Astryx sizes a hit area after it measures. */
async function smallTargets(): Promise<string[]> {
  let small = await measureTargets();
  for (let i = 0; i < 20 && small.length > 0; i++) {
    await s.page.waitForTimeout(100);
    small = await measureTargets();
  }
  return small;
}

/**
 * Elements showing exactly `text` that are cut: past the viewport, past an ancestor that clips,
 * or wider than their own box.
 */
const cutText = (text: string) =>
  s.page.getByText(text, { exact: true }).evaluateAll(
    (all) =>
      all.filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.right > innerWidth + 0.5 || el.scrollWidth > el.clientWidth + 1) return true;
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (
            getComputedStyle(p).overflowX !== "visible" &&
            r.right > p.getBoundingClientRect().right + 0.5
          )
            return true;
        }
        return false;
      }).length,
  );

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
  test("gives every target at least 44 x 44 px under a coarse pointer", async () => {
    expect(await s.page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    expect(await smallTargets()).toEqual([]);
    // A tap beside the 24 px checkbox selects the row and does not open the message.
    const cell = s.page.locator(`[data-message-row="note1"] [data-select-cell]`);
    expect(await cell.count()).toBe(1);
    const box = await rect(cell);
    await s.page.touchscreen.tap(box.left + 4, box.top + 4);
    await s.page.getByText("Selected: 1").waitFor();
    expect(s.page.url()).toBe(`${app.origin}/`);
    await s.page.getByRole("button", { name: "Open navigation" }).click();
    await s.page.getByRole("link", { name: "Settings" }).waitFor();
    expect(await smallTargets()).toEqual([]);
    await s.page.keyboard.press("Escape");
    for (const [path, ready] of [
      ["/?m=long", "text=Hello."],
      ["/?compose=phone", "[data-compose]"],
      ["/settings/addresses", `text=${LONG}`],
      ["/settings", "text=API keys"],
    ] as [string, string][]) {
      await go(path, ready);
      expect([path, await smallTargets()]).toEqual([path, []]);
    }
  });

  test("keeps the app name whole and moves the language and theme buttons to the drawer", async () => {
    await go("/", `[data-message-row="note3"]`);
    const bar = s.page.getByRole("navigation", { name: "Main navigation" });
    expect(await bar.getByRole("combobox").count()).toBe(0);
    const name = bar.getByText("MelodyMail", { exact: true });
    for (const width of [PHONE.width, 360]) {
      await s.page.setViewportSize({ width, height: PHONE.height });
      expect([width, await name.evaluate((el) => el.scrollWidth <= el.clientWidth)]).toEqual([
        width,
        true,
      ]);
    }
    await s.page.setViewportSize(PHONE);
    // The two menus left the app bar for the end of the drawer.
    expect(await bar.getByRole("button", { name: /^(Language|Theme):/ }).count()).toBe(0);
    await s.page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = s.page.getByRole("dialog");
    await drawer.getByRole("link", { name: "Settings" }).waitFor();
    await drawer.getByRole("button", { name: "Language: English" }).waitFor();
    await drawer.getByRole("button", { name: "Theme: System" }).waitFor();
    expect(await drawer.getByRole("combobox").count()).toBe(0);
    // The drawer panel pads by the safe area on the top, the bottom and its screen edge. A
    // browser here reports every inset as 0, so this reads the rules that apply to the panel.
    const insets = await drawer.evaluate((dialog) => {
      const panel = dialog.querySelector(":scope > [tabindex='-1']");
      const found = new Set<string>();
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (!(rule instanceof CSSStyleRule) || !panel?.matches(rule.selectorText)) continue;
          for (const side of ["top", "bottom", "left", "right"]) {
            const value = rule.style.getPropertyValue(`padding-${side}`);
            if (value.includes(`safe-area-inset-${side}`)) found.add(side);
          }
        }
      }
      const edge = dialog.getAttribute("data-side") === "start" ? "left" : "right";
      return { edge, found: [...found].sort() };
    });
    expect(insets.found).toEqual(["bottom", insets.edge, "top"].sort());
    await s.page.keyboard.press("Escape");
  });

  test("switches theme and language from their menus in the drawer, the current choice checked", async () => {
    await go("/", `[data-message-row="note3"]`);
    await s.page.getByRole("button", { name: "Open navigation" }).click();
    const bar = s.page.getByRole("dialog");
    await bar.getByRole("link", { name: "Settings" }).waitFor();
    const choices = async (button: string) => {
      await bar.getByRole("button", { name: button }).click();
      const items = s.page.getByRole("menuitemradio");
      await items.first().waitFor();
      return items.evaluateAll((all) =>
        all.map(
          (el) =>
            `${el.textContent?.trim()}${el.getAttribute("aria-checked") === "true" ? " *" : ""}`,
        ),
      );
    };
    // The theme button's icon shows the current mode.
    const glyph = (name: string) =>
      bar
        .getByRole("button", { name })
        .locator("svg")
        .evaluate((svg) => svg.innerHTML);
    const systemGlyph = await glyph("Theme: System");
    expect(await choices("Theme: System")).toEqual(["System *", "Light", "Dark"]);
    await s.page.getByRole("menuitemradio", { name: "Dark" }).click();
    await bar.getByRole("button", { name: "Theme: Dark" }).waitFor();
    expect(await glyph("Theme: Dark")).not.toBe(systemGlyph);
    expect(await s.page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await s.page.evaluate(() => localStorage.getItem("melodymail.mode"))).toBe("dark");
    expect(await choices("Theme: Dark")).toEqual(["System", "Light", "Dark *"]);
    await s.page.getByRole("menuitemradio", { name: "System" }).click();
    await bar.getByRole("button", { name: "Theme: System" }).waitFor();

    expect(await choices("Language: English")).toEqual(["简体中文", "English *", "日本語"]);
    await s.page.getByRole("menuitemradio", { name: "日本語" }).click();
    await bar.getByRole("button", { name: "言語：日本語" }).waitFor();
    expect(await s.page.evaluate(() => localStorage.getItem("melodymail.locale"))).toBe("ja-JP");
    expect(await choices("言語：日本語")).toEqual(["简体中文", "English", "日本語 *"]);
    await s.page.getByRole("menuitemradio", { name: "English" }).click();
    await bar.getByRole("button", { name: "Language: English" }).waitFor();
  });

  test("wraps a long address in a settings row, clear of its actions", async () => {
    await go("/settings/addresses", `text=${LONG}`);
    expect(await cutText(LONG)).toBe(0);
    const value = await rect(s.page.getByText(LONG, { exact: true }));
    const row = s.page.getByRole("listitem").filter({ hasText: LONG });
    const width = await s.page.evaluate(() => innerWidth);
    // The actions sit below the fields, never on a line the value needs.
    const buttons = await row.getByRole("button").all();
    expect(buttons.length).toBe(2);
    for (const button of buttons)
      expect((await rect(button)).top).toBeGreaterThanOrEqual(value.bottom);
    expect(await s.page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });

  test("keeps a code on one line in a stacked row", async () => {
    await go("/settings/domains/example.com", "text=mx.test.example");
    const type = s.page.getByText("MX", { exact: true });
    expect(await type.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap");
    const host = s.page.getByText("mx.test.example", { exact: true });
    expect(await host.evaluate((el) => getComputedStyle(el).whiteSpace)).not.toBe("nowrap");
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

  test("keeps a long sender address on screen in the reader", async () => {
    await go("/?m=long", "text=Hello.");
    expect(await s.page.getByText(SENDER, { exact: true }).count()).toBeGreaterThan(0);
    expect(await cutText(SENDER)).toBe(0);
  });

  test("reflows a 640 px newsletter to the width of the mail frame", async () => {
    await go("/?m=wide", "iframe");
    const frame = s.page.frameLocator("iframe");
    await frame.locator("#wide").waitFor();
    const iframe = s.page.locator("iframe");
    expect(await iframe.getAttribute("sandbox")).toBe(
      "allow-popups allow-popups-to-escape-sandbox",
    );
    const widths = await frame
      .locator("html")
      .evaluate((html) => ({ scroll: html.scrollWidth, client: html.clientWidth }));
    expect(widths.client).toBeLessThan(PHONE.width);
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
    // The narrowed picture keeps its 3:1 shape.
    const picture = await frame.locator("img").evaluate((img) => {
      const r = img.getBoundingClientRect();
      return r.width / r.height;
    });
    expect(picture).toBeCloseTo(3, 1);
  });

  test("puts the rarer reader actions under More", async () => {
    await go("/?m=long", "text=Hello.");
    const bar = s.page.getByRole("toolbar", { name: "Message actions" });
    expect(await bar.getByRole("button").evaluateAll((b) => b.map((e) => e.ariaLabel))).toEqual([
      "Back to the list",
      "Reply",
      "Archive",
      "Move to Trash",
      "More actions",
    ]);
    await bar.getByRole("button", { name: "More actions" }).click();
    const menu = s.page.getByRole("menu");
    await menu.waitFor();
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
      "Reply all",
      "Forward",
      "Star",
      "Mark as unread",
    ]);
    await menu.getByRole("menuitem", { name: "Star" }).click();
    await menu.waitFor({ state: "hidden" });
    await s.page.waitForFunction(() => document.querySelector('[aria-label="Unstar"]') === null);
    expect(app.patches.at(-1)).toEqual({ path: "/api/messages/long", body: { starred: true } });
  });

  test("names the dark reading state in the phone More menu", async () => {
    await s.page.evaluate(() => localStorage.setItem("melodymail.mode", "dark"));
    await go("/?m=wide", "iframe");
    await s.page.frameLocator("iframe").locator("#wide").waitFor();
    const more = s.page
      .getByRole("toolbar", { name: "Message actions" })
      .getByRole("button", { name: "More actions" });
    const dark = s.page.getByRole("menuitemcheckbox", { name: "Dark reading" });
    await more.click();
    expect(await dark.getAttribute("aria-checked")).toBe("false");
    await dark.click();
    await s.page.keyboard.press("Escape");
    await s.page.getByRole("menu").waitFor({ state: "hidden" });
    await more.click();
    expect(await dark.getAttribute("aria-checked")).toBe("true");
    await s.page.keyboard.press("Escape");
    await s.page.evaluate(() => localStorage.removeItem("melodymail.mode"));
  });

  test("puts star and read state in the list's More menu", async () => {
    await go("/", `[data-message-row="note3"]`);
    const bar = s.page.getByRole("toolbar", { name: "Actions on selected messages" });
    expect(await bar.getByRole("button").evaluateAll((b) => b.map((e) => e.ariaLabel))).toEqual([
      "Archive",
      "Move to Trash",
      "More actions",
    ]);
  });

  test("keeps one browser bar colour that follows a manual theme", async () => {
    const metas = () =>
      s.page.evaluate(() =>
        [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => [
          m.getAttribute("content"),
          m.getAttribute("media"),
        ]),
      );
    expect(await metas()).toEqual([["#f1f1f1", null]]);
    await s.page.evaluate(() => localStorage.setItem("melodymail.mode", "dark"));
    await go("/", `[data-message-row="note3"]`);
    await s.page.waitForFunction(
      () =>
        document.querySelector('meta[name="theme-color"]')?.getAttribute("content") !== "#f1f1f1",
    );
    expect(await metas()).toEqual([["#1b1b1b", null]]);
    const head = await s.page.evaluate(() => ({
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
      statusBar: document
        .querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
        ?.getAttribute("content"),
    }));
    expect(head).toEqual({
      viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
      statusBar: "black-translucent",
    });
  });

  test("paints html and body in the theme body colour, light and dark", async () => {
    const colours = () =>
      s.page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--color-background-body)";
        document.body.append(probe);
        const theme = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          theme,
          html: getComputedStyle(document.documentElement).backgroundColor,
          body: getComputedStyle(document.body).backgroundColor,
        };
      });
    for (const mode of ["light", "dark"]) {
      await s.page.evaluate((m) => localStorage.setItem("melodymail.mode", m), mode);
      await go("/", `[data-message-row="note3"]`);
      const found = await colours();
      expect([mode, found.html, found.body]).toEqual([mode, found.theme, found.theme]);
    }
    await s.page.evaluate(() => localStorage.removeItem("melodymail.mode"));
  });
});
