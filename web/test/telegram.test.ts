import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openSession, type Session, shutdown } from "./browser";
import { passkey } from "./passkey";
import { StubApp } from "./stub-app";
import { CODE } from "./stub-telegram";

// Settings > Notifications > Telegram in every state against the API stand-in
// (docs/M5b-telegram.md, "Settings screen"): Connect through the Passkey step-up, the pending
// poll ending in "on", the test card, Disconnect with confirmation and the banners.

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

async function open(status: Record<string, unknown>) {
  app.telegram.status = status;
  session = await openSession(app.origin, "/settings/notifications");
  await session.page.getByRole("heading", { name: "Telegram" }).waitFor();
  return session.page;
}

describe("Telegram settings", () => {
  test("explains a server without a token and a page not on the deployed address", async () => {
    const page = await open({ state: "notConfigured" });
    await page.getByText("Telegram isn't set up on this server").waitFor();
    app.telegram.status = { state: "httpsRequired" };
    await page.reload();
    await page.getByText("Telegram needs the deployed address").waitFor();
    expect(await page.getByRole("button", { name: "Connect Telegram" }).count()).toBe(0);
  });

  test("connects through the Passkey prompt and polls until the chat is bound", async () => {
    const page = await open({ state: "off" });
    await passkey(page);
    // The page polls every 3 s; the fake clock runs those seconds at once.
    await page.clock.install();
    await page.getByRole("button", { name: "Connect Telegram" }).click();
    const link = page.getByRole("link", { name: /Open Telegram/ });
    await link.waitFor();
    expect(await link.getAttribute("href")).toBe(`https://t.me/melody_test_bot?start=${CODE}`);
    expect(await link.getAttribute("target")).toBe("_blank");
    await page.getByText(`/start ${CODE}`).waitFor();
    const userSelect = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).userSelect);
    expect(await userSelect("code")).toBe("text");
    expect(await userSelect("h1")).toBe("none");
    await page.getByText(/^The code expires at /).waitFor();
    expect(app.telegram.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/telegram",
      "POST /api/telegram/link",
      "POST /api/auth/reauth/options",
      "POST /api/auth/reauth/verify",
      "POST /api/telegram/link",
    ]);
    app.telegram.status = {
      state: "on",
      chatLabel: "@owner",
      boundAt: Date.now(),
      lastError: null,
    };
    await page.clock.runFor(3100);
    await page.getByText(/^Connected to @owner since /).waitFor();
    await page.getByText("Telegram connected.").first().waitFor();
    const polls = app.telegram.calls.filter((c) => c.method === "GET").length;
    await page.clock.runFor(10_000);
    expect(app.telegram.calls.filter((c) => c.method === "GET").length).toBe(polls);
    expect(await page.getByText(/^Connected to @owner since /).isVisible()).toBe(true);
  });

  test("returns to Connect when the code expires", async () => {
    const page = await open({ state: "off" });
    app.telegram.reauthed = true;
    await page.clock.install();
    await page.getByRole("button", { name: "Connect Telegram" }).click();
    await page.getByText(`/start ${CODE}`).waitFor();
    await page.clock.runFor(601_000);
    await page.getByText("The code expired. Connect again to get a new one.").first().waitFor();
    await page.getByRole("button", { name: "Connect Telegram" }).waitFor();
  });

  test("cancels a pending code, and offers a new one after a reload", async () => {
    const page = await open({ state: "pending", expiresAt: Date.now() + 60_000 });
    await page
      .getByText("A code is waiting, but it is shown only once.", { exact: false })
      .waitFor();
    await page.getByRole("button", { name: "Create a new code" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Connect Telegram" }).waitFor();
    expect(app.telegram.calls.at(-1)).toEqual({ method: "DELETE", path: "/api/telegram/link" });
  });

  test("sends a test card, shows a failed send, and disconnects after confirmation", async () => {
    const page = await open({
      state: "on",
      chatLabel: "@owner",
      boundAt: Date.now(),
      lastError: null,
    });
    await page.getByRole("button", { name: "Send test card" }).click();
    await page.getByText("Test card sent.", { exact: false }).first().waitFor();
    app.telegram.testFails = true;
    await page.getByRole("button", { name: "Send test card" }).click();
    await page.getByText("Telegram didn't accept the request.", { exact: false }).first().waitFor();
    await page.getByText("The last card couldn't be sent").waitFor();
    await page.getByText("The bot is blocked in Telegram. Send a test card to check.").waitFor();
    await page.getByRole("button", { name: "Disconnect" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText("Disconnect Telegram?").waitFor();
    expect(app.telegram.calls.some((c) => c.method === "DELETE")).toBe(false);
    await dialog.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("button", { name: "Connect Telegram" }).waitFor();
    expect(app.telegram.calls.at(-1)).toEqual({ method: "DELETE", path: "/api/telegram" });
  });
});
