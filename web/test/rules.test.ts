import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import { StubApp } from "./stub-app";

// Settings > Rules against the API stand-in (docs/M6-rules-api.md, "Screens"): create through the
// dialog with a test against a stored message, reorder, switch off and delete with the keyboard,
// the phone layout and the copy in another locale.

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

const RULE = {
  enabled: true,
  match: "all",
  conditions: [{ field: "from", op: "ends_with", value: "@github.com" }],
  targetIds: [],
  markRead: false,
  star: false,
  archive: true,
  trash: false,
  stop: false,
};

/** Waits for the stand-in to have seen a request. */
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20);
  expect(check()).toBe(true);
}

async function open(width = 1280, locale = "en") {
  session = await openSession(app.origin, "/settings/rules", {
    prepare: async (page) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((l) => localStorage.setItem("melodymail.locale", l), locale);
    },
  });
  return session.page;
}

describe("Settings > Rules", () => {
  test("creates a rule in the dialog after testing it, and changes nothing by testing", async () => {
    const page = await open();
    await page.getByText("No rules yet").first().waitFor();
    await page.getByRole("button", { name: "Create rule" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("GitHub");
    await dialog.getByLabel("Condition 1: value").fill("@github.com");
    await dialog.getByRole("combobox", { name: "Condition 1: comparison" }).click();
    await page.getByRole("option", { name: "ends with" }).click();
    await dialog.getByRole("checkbox", { name: "me@out.test" }).check();
    await dialog.getByRole("checkbox", { name: "Archive" }).check();

    await dialog.getByRole("button", { name: "Test rule" }).click();
    await dialog.getByText("The rule matches this message").first().waitFor();
    await dialog.getByText("Condition 1 matches. It would: Archive.").first().waitFor();
    const tested = app.rules.calls.find((c) => c.path === "/api/rules/test");
    expect(tested?.body).toMatchObject({
      messageId: "hostile",
      rule: { conditions: [{ field: "from", op: "ends_with", value: "@github.com" }] },
    });
    expect(app.rules.rules).toEqual([]);

    await dialog.getByRole("button", { name: "Create rule" }).click();
    await page
      .getByText('From ends with "@github.com" → Forward to me@out.test, Archive')
      .first()
      .waitFor();
    expect(app.rules.rules[0]).toMatchObject({ name: "GitHub", targetIds: [7], archive: true });
  });

  test("reorders, switches off and deletes with the keyboard alone", async () => {
    app.rules.rules = [
      { ...RULE, id: 1, name: "First" },
      { ...RULE, id: 2, name: "Second" },
    ];
    const page = await open();
    const down = page.getByRole("button", { name: "Move First down" });
    await down.focus();
    await page.keyboard.press("Enter");
    await page.getByText("Order saved").first().waitFor();
    expect(app.rules.calls.find((c) => c.path === "/api/rules/order")?.body).toEqual({
      ids: [2, 1],
    });
    await page.getByText("1. Second").first().waitFor();

    await page.getByRole("switch", { name: "Rule First on" }).focus();
    await page.keyboard.press("Space");
    await until(() => app.rules.rules.find((r) => r.id === 1)?.enabled === false);
    await page.getByRole("button", { name: "Delete" }).first().focus();
    await page.keyboard.press("Enter");
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).press("Enter");
    await page.getByText("Rule deleted").first().waitFor();
    const methods = app.rules.calls.map((c) => `${c.method} ${c.path}`);
    expect(methods).toContain("PUT /api/rules/1");
    expect(app.rules.rules.map((r) => r.name)).toEqual(["First"]);
    expect(app.rules.rules[0]?.enabled).toBe(false);
  });

  test("stacks at phone width without sideways scroll, in Chinese", async () => {
    app.rules.rules = [{ ...RULE, id: 1, name: "GitHub" }];
    const page = await open(390, "zh-CN");
    await page.getByText("发件人结尾是“@github.com” → 归档").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(await page.locator("table").count()).toBe(0);
    const select = await page
      .getByText("发件人结尾是“@github.com” → 归档")
      .evaluate((el) => getComputedStyle(el).userSelect);
    expect(select).toBe("none");
  });
});
