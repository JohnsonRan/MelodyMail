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
    await page.goto(`${app.origin}/settings/notifications`);
    await page.getByText("Push isn't set up on this server").waitFor();
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

  test("a navigation to an API URL reaches the Worker, not the cached shell", async () => {
    const res = await page.goto(`${app.origin}/api/counts`);
    expect(res?.headers()["content-type"]).toContain("application/json");
    expect(await page.locator("#root").count()).toBe(0);
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

// Chromium's real PushManager would register with Google's push service, which tests must not
// reach (AGENTS.md, hard limits); these pages get a stand-in that keeps one subscription in memory.
const KEY = Buffer.from([4, ...Array.from({ length: 64 }, (_, i) => i)]).toString("base64url");

async function pushPage(options: { permission?: NotificationPermission; hidden?: boolean } = {}) {
  const p = await context.newPage();
  await p.addInitScript((opts) => {
    const w = window as unknown as { shown: { title: string; options: NotificationOptions }[] };
    w.shown = [];
    let current: unknown = null;
    const decode = (k: string) =>
      Uint8Array.from(atob(k.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    PushManager.prototype.subscribe = async (o?: PushSubscriptionOptionsInit) => {
      const key = decode(String(o?.applicationServerKey));
      current = {
        endpoint: "https://fcm.googleapis.com/fcm/send/stand-in",
        options: { applicationServerKey: key.buffer },
        toJSON: () => ({
          endpoint: "https://fcm.googleapis.com/fcm/send/stand-in",
          keys: { p256dh: "p", auth: "a" },
        }),
        unsubscribe: async () => {
          current = null;
          return true;
        },
      };
      return current as PushSubscription;
    };
    PushManager.prototype.getSubscription = async () => current as PushSubscription | null;
    ServiceWorkerRegistration.prototype.showNotification = async (title, options = {}) => {
      w.shown.push({ title, options });
    };
    if (opts.permission) {
      Object.defineProperty(Notification, "permission", { get: () => opts.permission });
      Notification.requestPermission = async () => opts.permission as NotificationPermission;
    }
    if (opts.hidden) Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
  }, options);
  return p;
}

describe("notifications settings", () => {
  test("says push is not set up when the Worker has no key", async () => {
    const p = await pushPage({ permission: "granted" });
    await p.goto(`${app.origin}/settings/notifications`);
    await p.getByText("Push isn't set up on this server").waitFor();
    expect(await p.getByRole("switch").count()).toBe(0);
    await p.close();
  });

  test("subscribes on the owner's click, sends a test and unsubscribes", async () => {
    app.pushKey = KEY;
    const p = await pushPage({ permission: "granted" });
    await p.goto(`${app.origin}/settings/notifications`);
    const toggle = p.getByRole("switch", { name: "Notify me about new mail" });
    await toggle.waitFor();
    expect(await toggle.isChecked()).toBe(false);
    expect(app.push.filter((c) => c.method !== "GET")).toEqual([]);
    await toggle.click();
    await p.getByText("Notifications turned on.").first().waitFor();
    expect(app.push).toContainEqual({
      method: "PUT",
      path: "/api/push/subscription",
      body: {
        endpoint: "https://fcm.googleapis.com/fcm/send/stand-in",
        keys: { p256dh: "p", auth: "a" },
      },
    });
    await p.getByRole("button", { name: "Send test notification" }).click();
    await p.getByText("Test notification sent.").first().waitFor();
    expect(app.push).toContainEqual({ method: "POST", path: "/api/push/test", body: {} });
    await toggle.click();
    await p.getByText("Notifications turned off.").first().waitFor();
    expect(app.push).toContainEqual({
      method: "DELETE",
      path: "/api/push/subscription",
      body: null,
    });
    await p.close();
  });

  test("explains a blocked permission", async () => {
    app.pushKey = KEY;
    const p = await pushPage({ permission: "denied" });
    await p.goto(`${app.origin}/settings/notifications`);
    await p.getByText("Notifications are blocked").waitFor();
    await p.close();
  });
});

describe("notification from an open page", () => {
  test("a hidden page with push on shows new mail itself; a visible one does not", async () => {
    app.pushKey = KEY;
    for (const hidden of [true, false]) {
      const p = await pushPage({ permission: "granted", hidden });
      await p.goto(`${app.origin}/settings/notifications`);
      const toggle = p.getByRole("switch", { name: "Notify me about new mail" });
      await toggle.waitFor();
      // With push off on this device, a hidden page stays quiet too.
      for (const ws of app.sockets) ws.send(JSON.stringify({ type: "message", id: "hostile" }));
      await p.waitForTimeout(300);
      expect(await p.evaluate(() => (window as unknown as { shown: unknown[] }).shown)).toEqual([]);
      await toggle.click();
      await p.getByText("Notifications turned on.").first().waitFor();
      for (const ws of app.sockets) ws.send(JSON.stringify({ type: "message", id: "hostile" }));
      if (hidden)
        await p.waitForFunction(() => (window as unknown as { shown: unknown[] }).shown.length > 0);
      else await p.waitForTimeout(300);
      const shown = await p.evaluate(() => (window as unknown as { shown: unknown[] }).shown);
      expect(shown).toEqual(
        hidden
          ? [
              {
                title: "Sender",
                options: {
                  body: "Hostile\nshop@example.com",
                  tag: "message:hostile",
                  icon: "/pwa-192x192.png",
                  data: { url: "/?m=hostile" },
                },
              },
            ]
          : [],
      );
      await p.close();
    }
  });
});
