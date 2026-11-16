import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

// Shared set-up for the browser suite (`bun run test:browser`): Playwright drives Chromium from
// `bun test`. Every request that is not for the local test server is recorded and aborted, so no
// test traffic leaves the machine and a test can assert that a page asked for nothing remote.

export type Session = {
  page: Page;
  /** Remote URLs the page (or any frame in it) tried to load. */
  remote: string[];
  /** The subset of `remote` that a child frame (the mail frame) asked for. */
  remoteFromFrames: string[];
  /** Popups and new tabs the page opened. */
  popups: Page[];
};

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function sharedContext(): Promise<BrowserContext> {
  browser ??= await chromium.launch();
  // Service workers are blocked here: a worker answering from its cache would hide requests from
  // the capture above. The PWA suite runs its own context with them allowed.
  context ??= await browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
  return context;
}

export async function shutdown(): Promise<void> {
  await browser?.close();
  browser = null;
  context = null;
}

/** A new page on `origin`; close it with `session.page.close()`. */
export async function openSession(origin: string, path = "/"): Promise<Session> {
  const page = await (await sharedContext()).newPage();
  const remote: string[] = [];
  const remoteFromFrames: string[] = [];
  const popups: Page[] = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    remote.push(url);
    if (route.request().frame() !== page.mainFrame()) remoteFromFrames.push(url);
    return route.abort();
  });
  page.on("popup", (p) => popups.push(p));
  await page.goto(`${origin}${path}`);
  return { page, remote, remoteFromFrames, popups };
}

/** A blank page in the shared context that may load nothing remote; close it after use. */
export async function blankPage(): Promise<Page> {
  const page = await (await sharedContext()).newPage();
  await page.route("**/*", (route) => route.abort());
  return page;
}

/** Builds a browser bundle of one entry for the test server. */
export async function bundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, entry)],
    target: "browser",
    format: "esm",
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  const [output] = result.outputs;
  if (!output) throw new Error("bundle produced nothing");
  return output.text();
}
