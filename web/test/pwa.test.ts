import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";
import { StubApp } from "./stub-app";

// The installable app (docs/M4b-pwa.md, "Proof the change needs", browser tier): manifest and
// installability, the service worker's cache, offline start and the update prompt. A persistent
// context, because Chromium reports installability only for a profile on disk. Requests that
// leave the test server are aborted, as in browser.ts.

const SW = readFileSync(join(import.meta.dir, "..", "dist", "sw.js"), "utf8");

let app: StubApp;
let profile: string;
let context: BrowserContext;
let page: Page;
const remote: string[] = [];

beforeAll(async () => {
  app = new StubApp();
  profile = mkdtempSync(join(tmpdir(), "melodymail-pwa-"));
  context = await chromium.launchPersistentContext(profile, { serviceWorkers: "allow" });
  // Only other origins are intercepted, so the app's own requests keep their normal timing.
  await context.route(
    (url) => url.origin !== app.origin,
    (route) => {
      remote.push(route.request().url());
      return route.abort();
    },
  );
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(app.origin);
  // The first worker activates without a page to control; a reload puts the page under it.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.locator('[data-message-row="note3"]').waitFor();
});

beforeEach(() => {
  app.reset();
});

afterAll(async () => {
  await context.close();
  await app.stop();
  rmSync(profile, { recursive: true, force: true });
});

describe("installable app", () => {
  test("has a valid manifest and Chromium reports no installability error", async () => {
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      return link ? (await fetch(link.href)).json() : null;
    });
    expect(manifest).toMatchObject({
      name: "MelodyMail",
      short_name: "MelodyMail",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    const icons = (manifest.icons as { sizes: string; purpose?: string }[]).map(
      (i) => `${i.sizes}${i.purpose ? ` ${i.purpose}` : ""}`,
    );
    expect(icons).toEqual(["192x192", "512x512", "512x512 maskable"]);
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    expect(installabilityErrors).toEqual([]);
    expect(remote).toEqual([]);
  });

  test("the worker controls the page and never caches an API answer", async () => {
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await page.locator('[data-message-row="hostile"]').click();
    await page.locator("iframe").waitFor();
    await page.goto(`${app.origin}/starred`);
    await page.getByRole("heading", { name: "Starred", level: 1 }).waitFor();
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
      }
      return urls;
    });
    // The shell is there, so the check sees real content.
    expect(cached.some((u) => u.includes("/index.html"))).toBe(true);
    expect(cached.some((u) => u.includes("/manifest.webmanifest"))).toBe(true);
    expect(cached.filter((u) => new URL(u).pathname.startsWith("/api"))).toEqual([]);
  });
});

describe("offline", () => {
  test("a reload opens the shell with the offline state, and going online recovers", async () => {
    await page.goto(app.origin);
    await page.locator('[data-message-row="note3"]').waitFor();
    await context.setOffline(true);
    try {
      await page.reload();
      await page.getByText("You're offline").first().waitFor();
      expect(await page.getByRole("link", { name: "Inbox" }).count()).toBeGreaterThan(0);
      await page
        .getByRole("heading", { name: "Your mail loads when you're back online." })
        .waitFor();
      expect(await page.getByText("Something went wrong").count()).toBe(0);
    } finally {
      await context.setOffline(false);
    }
    await page.locator('[data-message-row="note3"]').waitFor();
    expect(await page.getByText("You're offline").count()).toBe(0);
  });
});

describe("updates", () => {
  test("a waiting worker shows the banner, and Reload moves the page onto it", async () => {
    await page.goto(app.origin);
    await page.locator('[data-message-row="note3"]').waitFor();
    app.overrides.set("/sw.js", `${SW}\n// next deployment\n`);
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
    const banner = page.getByText("A new version is available");
    await banner.waitFor();
    await page.evaluate(() => {
      (window as unknown as { beforeReload: boolean }).beforeReload = true;
    });
    await page.getByRole("button", { name: "Reload" }).click();
    await page.waitForFunction(
      () => !(window as unknown as { beforeReload?: boolean }).beforeReload,
    );
    await page.locator('[data-message-row="note3"]').waitFor();
    expect(await banner.count()).toBe(0);
    expect(
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting),
    ).toBeNull();
  });
});
