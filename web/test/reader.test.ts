import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { Frame } from "playwright";
import { bundle, openSession, type Session, shutdown } from "./browser";
import type { RenderInput, RenderResult } from "./harness";

// Rendering security (docs/M4-mailbox.md, "Proof the change needs"): a corpus of hostile HTML
// goes through the reader's real sanitizer and frame document in Chromium. Each case checks the
// sanitized HTML, that no sender script ran, and that nothing remote was requested while remote
// images are off. The layer tests prove the sandbox, the CSP and the sanitizer one at a time.

let server: Server<undefined>;
let origin: string;
let session: Session | null = null;

beforeAll(async () => {
  const script = await bundle("harness.ts");
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/harness.js") {
        return new Response(script, { headers: { "content-type": "text/javascript" } });
      }
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/harness.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  origin = server.url.origin;
});

afterAll(async () => {
  await shutdown();
  await server.stop(true);
});

/**
 * Renders into the one harness page. Each call first removes the previous frames and clears what
 * the page recorded, so a case sees only its own frame's requests and messages.
 */
async function render(input: RenderInput): Promise<{ result: RenderResult; s: Session }> {
  if (!session) {
    session = await openSession(origin);
    await session.page.waitForFunction(() => typeof window.renderMail === "function");
  }
  const s = session;
  await s.page.evaluate(() => {
    for (const frame of document.querySelectorAll("iframe")) frame.remove();
    window.posted = [];
  });
  s.remote.length = 0;
  s.popups.length = 0;
  const result = await s.page.evaluate((i) => window.renderMail(i), input);
  // Background images and imported styles load after the frame's load event.
  await s.page.waitForTimeout(150);
  return { result, s };
}

const posted = (s: Session) => s.page.evaluate(() => window.posted);

/** The mail frame: the one child frame of the harness page. */
function mailFrame(s: Session): Frame {
  const frame = s.page.frames().find((f) => f !== s.page.mainFrame());
  if (!frame) throw new Error("no mail frame");
  return frame;
}

/** The selectors that still match the sanitized HTML, parsed by the browser. */
function survivors(s: Session, html: string, selectors: string[]): Promise<string[]> {
  return s.page.evaluate(
    ([h, list]) => {
      const doc = new DOMParser().parseFromString(h, "text/html");
      return list.filter((sel) => doc.querySelector(sel) !== null);
    },
    [html, selectors] as const,
  );
}

/** The named attributes of every element matching `selector` in the sanitized HTML. */
function attributes(
  s: Session,
  html: string,
  selector: string,
  names: string[],
): Promise<(string | null)[][]> {
  return s.page.evaluate(
    ([h, sel, list]) => {
      const doc = new DOMParser().parseFromString(h, "text/html");
      return [...doc.querySelectorAll(sel)].map((el) => list.map((n) => el.getAttribute(n)));
    },
    [html, selector, names] as const,
  );
}

const TRACKER = "https://tracker.invalid";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function relatedEml(html: string, imageBase64: string, contentId = "logo@example.org"): string {
  return [
    "From: Sender <sender@example.org>",
    "To: shop@example.com",
    "Subject: Inline image",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "--rel",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    `Content-ID: <${contentId}>`,
    "",
    imageBase64,
    "--rel--",
    "",
  ].join("\r\n");
}

const HTML_ATTACHMENT_EML = [
  "From: Sender <sender@example.org>",
  "To: shop@example.com",
  "Subject: HTML attachment",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="mix"',
  "",
  "--mix",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>See the attachment.</p>",
  "--mix",
  'Content-Type: text/html; name="../../invoice<1>.html"',
  'Content-Disposition: attachment; filename="../../invoice<1>.html"',
  "",
  "<script>fetch('/api/messages').then(()=>opener&&opener.postMessage('attachment ran','*'))</script>",
  "--mix--",
  "",
].join("\r\n");

// The corpus. `gone` lists selectors that must not survive sanitizing; every case also asserts
// that no script ran and that nothing remote was requested.
const CORPUS: { name: string; html: string; gone: string[]; remote?: boolean }[] = [
  {
    name: "script tags",
    html: `<p>hi</p><script>parent.postMessage("script","*")</script><SCRIPT SRC="${TRACKER}/x.js"></SCRIPT>`,
    gone: ["script"],
  },
  {
    name: "onerror and onload handlers",
    html: `<img src="x" onerror="parent.postMessage('onerror','*')"><body onload="parent.postMessage('onload','*')"><div onmouseover="parent.postMessage('hover','*')">x</div>`,
    gone: ["[onerror]", "[onload]", "[onmouseover]"],
    remote: true,
  },
  {
    name: "meta refresh",
    html: `<meta http-equiv="refresh" content="0;url=${TRACKER}/refresh"><p>wait</p>`,
    gone: ["meta"],
  },
  {
    name: "base href",
    html: `<base href="${TRACKER}/"><a href="page">relative</a><img src="pic.png">`,
    gone: ["base", "img[src]"],
    remote: true,
  },
  {
    name: "forms",
    html: `<form action="${TRACKER}/steal" method="post"><input name="password"><button formaction="${TRACKER}/b">Send</button><textarea></textarea><select><option>a</option></select></form>`,
    gone: ["form", "input", "button", "textarea", "select"],
  },
  {
    name: "javascript, data and vbscript links",
    html: `<a id="js" href="javascript:parent.postMessage('js','*')">a</a><a id="data" href="data:text/html,<script>alert(1)</script>">b</a><a id="vb" href="vbscript:msgbox(1)">c</a><a id="tab" href=" JaVaScRiPt:alert(1)">d</a>`,
    gone: ["a[href]"],
  },
  {
    name: "SVG with script",
    html: `<svg xmlns="http://www.w3.org/2000/svg" onload="parent.postMessage('svgload','*')"><script>parent.postMessage("svg","*")</script><a href="javascript:alert(1)"><text>x</text></a><foreignObject><iframe src="${TRACKER}/f"></iframe></foreignObject></svg>`,
    gone: ["script", "[onload]", "a[href]", "iframe"],
  },
  {
    name: "embedded documents",
    html: `<iframe src="${TRACKER}/i"></iframe><object data="${TRACKER}/o"></object><embed src="${TRACKER}/e"><video src="${TRACKER}/v.mp4" poster="${TRACKER}/p.png"></video><link rel="stylesheet" href="${TRACKER}/l.css">`,
    gone: ["iframe", "object", "embed", "video", "link"],
  },
  {
    name: "CSS url() to remote hosts",
    html: `<style>body{background:url('${TRACKER}/body.png')} .x{background-image:url(//tracker.invalid/rel.png)}</style><div class="x" style="background:url(${TRACKER}/inline.png)">styled</div>`,
    gone: [],
    remote: true,
  },
  {
    name: "@import",
    html: `<style>@import url("${TRACKER}/import.css"); @import '${TRACKER}/import2.css';</style><p>styled</p>`,
    gone: [],
    remote: true,
  },
  {
    name: "remote images and tracking pixels",
    html: `<img src="${TRACKER}/pixel.gif" width="1" height="1"><img srcset="${TRACKER}/a.png 1x, ${TRACKER}/b.png 2x"><table background="${TRACKER}/bg.png"><tr><td>x</td></tr></table><picture><source srcset="${TRACKER}/s.png"><img src="${TRACKER}/p2.png"></picture>`,
    gone: ["img[src]", "img[srcset]", "[background]", "source"],
    remote: true,
  },
];

describe("hostile HTML corpus", () => {
  for (const c of CORPUS) {
    test(c.name, async () => {
      const { result, s } = await render({ html: c.html });
      expect(await survivors(s, result.sanitized, c.gone)).toEqual([]);
      expect(result.sanitized).not.toMatch(/javascript:|vbscript:|data:text\/html/i);
      expect(result.sandbox).toBe("allow-popups allow-popups-to-escape-sandbox");
      expect(result.srcdoc).toStartWith(
        `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
      );
      expect(result.srcdoc).toContain('<meta name="referrer" content="no-referrer">');
      if (c.remote) expect(result.hasRemoteContent).toBe(true);
      expect(await posted(s)).toEqual([]);
      expect(s.remote).toEqual([]);
      expect(s.popups).toEqual([]);
    });
  }

  test("links open a new tab without opener or referrer", async () => {
    const { result, s } = await render({
      html: `<a href="https://example.org/a">a</a><a href="mailto:x@example.org" target="_self">m</a><a id="rel" href="/api/messages">r</a><a id="proto" href="//sender.invalid/x">p</a>`,
    });
    expect(await attributes(s, result.sanitized, "a", ["target", "rel"])).toEqual([
      ["_blank", "noopener noreferrer"],
      ["_blank", "noopener noreferrer"],
      ["_blank", "noopener noreferrer"],
      ["_blank", "noopener noreferrer"],
    ]);
    // Relative and scheme-less links would resolve against the app's origin.
    expect(await survivors(s, result.sanitized, ["#rel[href]", "#proto[href]"])).toEqual([]);
  });

  // A special scheme without "//" is still resolved against the base URL (WHATWG URL), which
  // for srcdoc is the app's own page: "http:/api/x" opens https://<app>/api/x.
  test("drops scheme-relative links that resolve against the app origin", async () => {
    const hrefs = ["https:/api/messages", "http:api", "http:\\evil.example/h", "HTTPS:/x"];
    const html = hrefs
      .map(
        (h, i) =>
          `<a id="h${i}" href="${h}">h</a><svg xmlns:xlink="http://www.w3.org/1999/xlink"><a id="x${i}" xlink:href="${h}"><text>x</text></a></svg>`,
      )
      .join("");
    const { result, s } = await render({
      html: `${html}<a id="ok" href="https://example.org/">ok</a>`,
    });
    for (const [i, h] of hrefs.entries()) {
      expect(await attributes(s, result.sanitized, `#h${i}`, ["href"]), h).toEqual([[null]]);
      expect(await attributes(s, result.sanitized, `#x${i}`, ["xlink:href", "href"]), h).toEqual([
        [null, null],
      ]);
    }
    expect(await attributes(s, result.sanitized, "#ok", ["href"])).toEqual([
      ["https://example.org/"],
    ]);
  });

  // An SVG <a> reports a lowercase tagName; a link that is not sent to a new tab navigates the
  // mail frame itself to the sender's page, where the frame CSP no longer applies.
  for (const attr of ["href", "xlink:href"]) {
    test(`SVG links (${attr}) open a new tab and leave the mail frame in place`, async () => {
      const { result, s } = await render({
        html: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="50"><a ${attr}="https://sender.invalid/landing"><rect id="r" width="200" height="50"/></a></svg>`,
      });
      expect(await attributes(s, result.sanitized, "svg a", ["target", "rel"])).toEqual([
        ["_blank", "noopener noreferrer"],
      ]);
      const popup = s.page.waitForEvent("popup", { timeout: 3000 });
      await mailFrame(s).click("#r");
      await (await popup).close();
      await s.page.waitForTimeout(150);
      expect(mailFrame(s).url()).toBe("about:srcdoc");
    });
  }

  test("notices a remote url() in a style attribute alone", async () => {
    const { result, s } = await render({
      html: `<div style="background:url(${TRACKER}/only-inline.png)">x</div>`,
    });
    expect(result.hasRemoteContent).toBe(true);
    expect(s.remote).toEqual([]);
  });

  test("keeps inline styles and <style> for the layout", async () => {
    const { result, s } = await render({
      html: `<style>.box{color:rgb(1, 2, 3)}</style><p class="box" style="font-weight:700">styled</p>`,
    });
    expect(result.hasRemoteContent).toBe(false);
    const style = await mailFrame(s).evaluate(() => {
      const p = document.querySelector(".box");
      return p ? [getComputedStyle(p).color, getComputedStyle(p).fontWeight] : null;
    });
    expect(style).toEqual(["rgb(1, 2, 3)", "700"]);
  });

  test("shows remote images only after the owner allows them", async () => {
    const html = `<img src="${TRACKER}/pixel.gif"><div style="background:url(${TRACKER}/bg.png)">x</div>`;
    const off = await render({ html });
    expect(off.result.hasRemoteContent).toBe(true);
    expect(off.s.remote).toEqual([]);
    // The same capture sees the requests once remote images are on, so an empty list above is
    // evidence and not a blind spot.
    const on = await render({ html, remoteImages: true });
    expect(on.result.srcdoc).toContain("img-src data: https:");
    expect(on.s.remote).toContain(`${TRACKER}/pixel.gif`);
    // CSS background images count as images for the CSP, so they load with the same switch.
    expect(on.s.remote).toContain(`${TRACKER}/bg.png`);
  });
});

describe("inline images", () => {
  test("rewrites a cid: image to a data: URL that loads in the sandbox", async () => {
    const eml = relatedEml('<p>Logo</p><img id="logo" src="cid:logo@example.org">', PNG_1X1);
    const { result, s } = await render({ eml });
    expect(await attributes(s, result.sanitized, "#logo", ["src"])).toEqual([
      [`data:image/png;base64,${PNG_1X1}`],
    ]);
    expect(result.usedContentIds).toEqual(["logo@example.org"]);
    const width = await mailFrame(s).evaluate(
      () => (document.querySelector("#logo") as HTMLImageElement | null)?.naturalWidth,
    );
    expect(width).toBe(1);
    expect(s.remote).toEqual([]);
  });

  test("shows a placeholder for an inline image over 2 MiB", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
    const lines = big.match(/.{1,76}/g)?.join("\r\n") ?? "";
    const eml = relatedEml('<img id="big" src="cid:big@example.org">', lines, "big@example.org");
    const { result, s } = await render({ eml });
    expect(await attributes(s, result.sanitized, "#big", ["src", "alt"])).toEqual([
      [null, "image too large"],
    ]);
  });

  test("leaves an unknown cid: image without a source", async () => {
    const { result, s } = await render({ html: '<img id="x" src="cid:missing@example.org">' });
    expect(await attributes(s, result.sanitized, "#x", ["src"])).toEqual([[null]]);
    expect(result.usedContentIds).toEqual([]);
    expect(s.remote).toEqual([]);
  });
});

describe("attachments", () => {
  test("downloads an HTML attachment as octet-stream and never opens it", async () => {
    const { result, s } = await render({ eml: HTML_ATTACHMENT_EML });
    expect(result.parts).toEqual([
      { filename: "../../invoice<1>.html", mimeType: "text/html", size: expect.any(Number) },
    ]);
    await s.page.evaluate(() => {
      const create = URL.createObjectURL.bind(URL);
      (window as unknown as { blobTypes: string[] }).blobTypes = [];
      URL.createObjectURL = (blob: Blob | MediaSource) => {
        (window as unknown as { blobTypes: string[] }).blobTypes.push((blob as Blob).type);
        return create(blob);
      };
    });
    const [download] = await Promise.all([
      s.page.waitForEvent("download"),
      s.page.evaluate(() => window.downloadPart(0)),
    ]);
    expect(download.suggestedFilename()).toBe("_.._invoice_1_.html");
    expect(
      await s.page.evaluate(() => (window as unknown as { blobTypes: string[] }).blobTypes),
    ).toEqual(["application/octet-stream"]);
    await s.page.waitForTimeout(250);
    expect(s.popups).toEqual([]);
    expect(await posted(s)).toEqual([]);
    expect(s.page.url()).toBe(`${origin}/`);
  });
});

describe("each layer on its own", () => {
  const SCRIPTS = `<script>parent.postMessage("script","*")</script><img src="x" onerror="parent.postMessage('onerror','*')">`;
  const REMOTE = `<img src="${TRACKER}/img.png"><style>@import url(${TRACKER}/i.css); p{background:url(${TRACKER}/bg.png)}</style><p>x</p>`;

  test("without any layer the probes fire, so the checks below can see a failure", async () => {
    const { s } = await render({
      html: SCRIPTS + REMOTE,
      layers: { sandbox: false, csp: false, sanitize: false },
    });
    expect((await posted(s)).sort()).toEqual(["onerror", "script"]);
    expect(s.remote.length).toBeGreaterThan(0);
  });

  test("the sandbox alone stops sender script", async () => {
    const { s } = await render({ html: SCRIPTS, layers: { csp: false, sanitize: false } });
    expect(await posted(s)).toEqual([]);
  });

  test("the CSP alone stops sender script and every remote load", async () => {
    const { s } = await render({
      html: SCRIPTS + REMOTE,
      layers: { sandbox: false, sanitize: false },
    });
    expect(await posted(s)).toEqual([]);
    expect(s.remote).toEqual([]);
  });

  test("the sanitizer alone stops sender script and remote images", async () => {
    const { s } = await render({
      html: `${SCRIPTS}<img src="${TRACKER}/img.png">`,
      layers: { sandbox: false, csp: false },
    });
    expect(await posted(s)).toEqual([]);
    expect(s.remote).toEqual([]);
  });
});
