import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { bundle, openSession, type Session, shutdown } from "./browser";

// The compose Markdown renderer (owner ruling 2026-11-16) in Chromium, through the real marked
// and DOMPurify: the GFM it supports, and that raw HTML, script links and images are neutralised.

let server: Server<undefined>;
let session: Session;

beforeAll(async () => {
  const script = await bundle("harness.ts");
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/harness.js") {
        return new Response(script, { headers: { "content-type": "text/javascript" } });
      }
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/harness.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  session = await openSession(server.url.origin);
  await session.page.waitForFunction(() => typeof window.renderMarkdown === "function");
});

afterAll(async () => {
  await shutdown();
  await server.stop(true);
});

const render = (source: string) => session.page.evaluate((s) => window.renderMarkdown(s), source);

describe("compose Markdown", () => {
  test("renders headings, lists, tables, code, links and autolinks", async () => {
    const { body } = await render(
      [
        "# Title",
        "## Part",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "Some `code`, **bold**, *em* and ~~gone~~.",
        "",
        "```",
        "let x = 1 < 2;",
        "```",
        "",
        "[site](https://example.org/a) <https://example.org/b> www.example.org mailto:me@example.org",
        "",
        "- [x] done",
      ].join("\n"),
    );
    for (const tag of [
      "<h1",
      "<h2",
      "<ul>",
      "<ol>",
      "<table",
      "<th",
      "<td",
      "<code",
      "<pre",
      "<strong>",
      "<em>",
      "<del>",
    ]) {
      expect(body, tag).toContain(tag);
    }
    expect(body).toContain("let x = 1 &lt; 2;");
    expect(body).toContain('href="https://example.org/a"');
    expect(body).toContain('href="https://example.org/b"');
    expect(body).toContain('href="http://www.example.org"');
    expect(body).toContain('href="mailto:me@example.org"');
    expect(body).toContain("☑ done");
    // The message's own inline styles.
    expect(body).toMatch(/<table style="border-collapse: collapse;/);
  });

  test("shows raw HTML as text and drops script links and images", async () => {
    const { body, doc } = await render(
      [
        '<script>alert("x")</script> <img src="https://tracker.invalid/p.gif" onerror="alert(1)">',
        '<b>bold?</b> <a href="https://evil.invalid">raw link</a>',
        "",
        "[js](javascript:alert(1)) [data](data:text/html,x) [vb](vbscript:x) [rel](/api/counts)",
        "",
        "![pixel](https://tracker.invalid/pixel.gif)",
      ].join("\n"),
    );
    expect(body).not.toMatch(
      /<script|<img|<b>|javascript:|vbscript:|data:text|tracker\.invalid\/pixel/i,
    );
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain('<a href="https://evil.invalid"');
    expect(body).not.toContain('href="/api/counts"');
    expect(body).toContain("pixel");
    expect(doc).toStartWith('<!doctype html><html><head><meta charset="utf-8"></head><body style=');
    expect(doc).not.toMatch(/<link|<style|@import|<img/i);
  });
});
