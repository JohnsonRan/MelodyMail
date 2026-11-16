import DOMPurify from "dompurify";
import { Marked } from "marked";

// Markdown to the HTML part of a sent message (owner ruling 2026-11-16). It runs in the browser,
// so the Worker spends no CPU on it. Raw HTML in the source is shown as text, images become their
// alt text (no remote resources), and the output goes through DOMPurify with a fixed list of
// tags; links keep their href only for http(s) and mailto.

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const marked = new Marked({
  gfm: true,
  async: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
    checkbox: ({ checked }) => (checked ? "☑ " : "☐ "),
  },
});

const ALLOWED_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const LINK = /^(https?:\/\/|mailto:)/i;

// The mail goes to other clients, which cannot read the app's design tokens; these inline styles
// are the message's own look, close to GitHub's Markdown, with no remote resource.
const FONT = "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace";
const STYLES: Record<string, string> = {
  a: "color: #0969da;",
  blockquote: "margin: 0 0 12px; padding: 0 12px; border-left: 3px solid #d0d7de; color: #57606a;",
  code: `font-family: ${MONO}; font-size: 90%; background: #f6f8fa; padding: 1px 4px; border-radius: 4px;`,
  pre: `font-family: ${MONO}; background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: auto;`,
  table: "border-collapse: collapse; margin: 0 0 12px;",
  th: "border: 1px solid #d0d7de; padding: 4px 8px; text-align: left;",
  td: "border: 1px solid #d0d7de; padding: 4px 8px;",
  p: "margin: 0 0 12px;",
};

/** A separate DOMPurify instance, so the reader's hooks and options stay its own. */
let purifier: ReturnType<typeof DOMPurify> | null = null;
function purify() {
  if (purifier) return purifier;
  purifier = DOMPurify(window);
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.localName === "a") {
      const href = node.getAttribute("href") ?? "";
      if (!LINK.test(href)) node.removeAttribute("href");
    }
    const style = STYLES[node.localName];
    if (style) node.setAttribute("style", style);
  });
  return purifier;
}

/** The sanitized HTML body of the Markdown source. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source) as string;
  return purify().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "title", "align", "start"],
    ALLOWED_URI_REGEXP: LINK,
  });
}

/** The HTML part as sent: a minimal document, styled inline, with nothing to fetch. */
export function emailHtml(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin: 0; padding: 16px; font-family: ${FONT}; font-size: 15px; line-height: 1.5; color: #1f2328;">${renderMarkdown(source)}</body></html>`;
}
