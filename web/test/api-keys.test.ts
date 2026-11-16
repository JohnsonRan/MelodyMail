import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import { passkey } from "./passkey";
import { StubApp } from "./stub-app";
import { CREATED_KEY } from "./stub-keys";

// Settings > API keys against the API stand-in (docs/M6-rules-api.md, "Screens"): create through
// the Passkey step-up, the key shown once and selectable, revoke with confirmation by keyboard,
// and the stacked phone layout in another locale.

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

async function open(width = 1280, locale = "en") {
  session = await openSession(app.origin, "/settings/api-keys", {
    prepare: async (page) => {
      await page.setViewportSize({ width, height: 900 });
      // Dialogs open and close without animation, so the steps do not wait for it.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((l) => localStorage.setItem("melodymail.locale", l), locale);
    },
  });
  return session.page;
}

describe("Settings > API keys", () => {
  test("creates a key through re-authentication, shows it once, and revokes it", async () => {
    const page = await open();
    await passkey(page);
    await page.getByText("No API keys yet").first().waitFor();
    // A button beside Create key, rendered as a plain anchor: the router would cancel the click.
    const link = page.getByRole("link", { name: "Download OpenAPI document" });
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.url()).toBe(`${app.origin}/api/openapi.json`);
    expect(download.suggestedFilename()).toBe("melodymail-openapi.json");

    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Create key" }).click();
    await dialog.getByText("Enter a name.").first().waitFor();
    expect(app.keys.calls.filter((c) => c.method === "POST")).toEqual([]);

    await dialog.getByLabel("Name").fill("Backup script");
    await dialog.getByRole("checkbox", { name: "Send mail" }).check();
    await dialog.getByRole("radio", { name: "Never" }).check();
    await dialog.getByRole("button", { name: "Create key" }).click();

    const shown = page.getByText(CREATED_KEY);
    await shown.waitFor();
    expect(await shown.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
    expect(app.keys.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { label: "Backup script", scopes: ["mail:read", "mail:send"], expiresInDays: null },
      { label: "Backup script", scopes: ["mail:read", "mail:send"], expiresInDays: null },
    ]);
    expect(app.telegram.calls.map((c) => c.path)).toContain("/api/auth/reauth/verify");
    const done = page.getByRole("button", { name: "Done" });
    expect(await done.isDisabled()).toBe(true);
    await page.getByRole("checkbox", { name: "I have copied the key" }).check();
    await done.click();
    expect(await page.getByText(CREATED_KEY).count()).toBe(0);

    await page.getByText("mmk_abcdefgh_…").first().waitFor();
    await page.getByText("Read mail, Send mail").first().waitFor();
    expect(await page.getByRole("cell", { name: "Never" }).count()).toBe(2);

    await page.getByRole("button", { name: "Revoke" }).first().focus();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("alertdialog");
    await confirm.getByText("Programs that use this key stop working at once.").first().waitFor();
    await confirm.getByRole("button", { name: "Revoke" }).press("Enter");
    await page.getByText("Key revoked").first().waitFor();
    expect(app.keys.keys).toEqual([]);
  });

  test("stacks at phone width without sideways scroll, in Chinese", async () => {
    const now = Date.now();
    app.keys.keys = [
      {
        id: 1,
        publicId: "abcdefgh",
        label: "备份",
        scopes: ["mail:read"],
        createdAt: now - 100 * 86_400_000,
        expiresAt: now - 10 * 86_400_000,
        lastUsedAt: now - 3_600_000,
        lastUsedIp: "2001:db8:1234:5678:9abc:def0:1234:5678",
      },
    ];
    const page = await open(390, "zh-CN");
    await page.getByText("已过期").first().waitFor();
    await page.getByText("读取邮件").first().waitFor();
    await page.getByText("2001:db8:1234:5678:9abc:def0:1234:5678").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(await page.locator("table").count()).toBe(0);
    // Both title actions fit at phone width.
    await page.getByRole("link", { name: "下载 OpenAPI 文档" }).waitFor();
    expect(await page.getByRole("link", { name: "下载 OpenAPI 文档" }).isVisible()).toBe(true);
  });
});
