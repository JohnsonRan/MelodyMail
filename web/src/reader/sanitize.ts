import DOMPurify from "dompurify";
import type { MailPart } from "./types";

// Sender HTML is rendered only inside a sandboxed srcdoc frame (docs/M4-mailbox.md, "Reading
// mail"). Three layers, each enough on its own against scripts, and the CSP enough on its own
// against remote loads:
//   1. the sandbox: no scripts, no same-origin, no forms, no top navigation;
//   2. a CSP <meta> first in <head>: nothing loads but inline styles and data: images and fonts;
//   3. DOMPurify, before the HTML becomes srcdoc.
// `allow-same-origin` must never be added: with it the frame would share the app's origin.

export const SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/** Inline images above this size show a placeholder instead of a data: URL. */
export const INLINE_IMAGE_MAX = 2 * 1024 * 1024;

export function frameCsp(remoteImages: boolean): string {
  const img = remoteImages ? "data: https:" : "data:";
  return `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:`;
}

// Elements that can run code, load or embed another document, submit data or change how the
// frame resolves URLs and navigates. <meta> goes entirely: http-equiv refresh could navigate the
// frame and a second CSP could only add confusion.
const FORBID_TAGS = [
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "base",
  "meta",
  "link",
  "audio",
  "video",
  "source",
  "track",
];

const REMOTE_CSS = /url\s*\(|@import/i;
// "//" is required: "http:/x" and "http:\x" resolve against the base URL, the app's own page.
const LINK_SCHEME = /^\s*(https?:\/\/|mailto:|tel:)/i;

export type SanitizedMail = {
  html: string;
  /** The message asks for remote images or styles, which stay blocked until the owner allows. */
  hasRemoteContent: boolean;
  /** Content-IDs the HTML showed inline, so the attachment list can leave them out. */
  usedContentIds: Set<string>;
};

export type SanitizeOptions = {
  parts: MailPart[];
  remoteImages: boolean;
  /** Alt text for an inline image too large to show. */
  tooLargeLabel: string;
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const isRemote = (url: string) => !/^\s*(data|cid):/i.test(url);

/** Sanitizes sender HTML for the frame body and rewrites cid: images to data: URLs. */
export function sanitizeMailHtml(dirty: string, options: SanitizeOptions): SanitizedMail {
  const byCid = new Map(options.parts.filter((p) => p.contentId).map((p) => [p.contentId, p]));
  const usedContentIds = new Set<string>();
  let hasRemoteContent = false;
  const purify = DOMPurify(window);

  purify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return;
    // localName, not tagName: an SVG <a> reports a lowercase tagName, and a link left without
    // target would navigate the mail frame itself to the sender's page.
    if (node.localName === "a" || node.localName === "area") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
      // A relative link resolves against the app's own URL (srcdoc inherits it) and would open
      // an app page in a new tab; mail has no use for one.
      for (const attr of ["href", "xlink:href"]) {
        const href = node.getAttribute(attr);
        if (href !== null && !LINK_SCHEME.test(href)) node.removeAttribute(attr);
      }
    }
    const src = node.getAttribute("src");
    if (node.localName === "img" && src !== null && /^\s*cid:/i.test(src)) {
      const id = decodeURIComponent(src.trim().slice(4)).toLowerCase();
      const part = byCid.get(id);
      if (part && part.content.byteLength <= INLINE_IMAGE_MAX) {
        node.setAttribute(
          "src",
          `data:${part.mimeType};base64,${base64(new Uint8Array(part.content))}`,
        );
      } else {
        node.removeAttribute("src");
        node.setAttribute("alt", options.tooLargeLabel);
      }
      if (part) usedContentIds.add(id);
    }
    for (const attr of ["src", "srcset", "background", "poster"]) {
      const value = node.getAttribute(attr);
      if (value === null || (attr !== "srcset" && !isRemote(value))) continue;
      hasRemoteContent = true;
      if (!options.remoteImages) node.removeAttribute(attr);
    }
    if (REMOTE_CSS.test(node.getAttribute("style") ?? "")) hasRemoteContent = true;
  });
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && REMOTE_CSS.test(node.textContent ?? "")) {
      hasRemoteContent = true;
    }
  });

  const html = purify.sanitize(dirty, {
    FORCE_BODY: true,
    FORBID_TAGS,
    RETURN_TRUSTED_TYPE: false,
  });
  return { html, hasRemoteContent, usedContentIds };
}

// Dark reading (owner, 2026-11-16): the whole page inverted, pictures inverted back so they look
// normal. <picture> is left out because its <img> already matches, and a second filter on a
// nested element would invert it again; <video> never reaches the frame (FORBID_TAGS).
export const DARK_READING_STYLE =
  "<style>html{filter:invert(1) hue-rotate(180deg)}" +
  'img,svg image,[background],[style*="url(" i]{filter:invert(1) hue-rotate(180deg)}</style>';

// Mail laid out for a fixed width (a 600-640 px newsletter) reflows to a narrow frame instead of
// running off its right edge (owner ruling 2026-11-17). Only frames up to 640 px wide get it, so
// mail that already fits a desktop reading pane keeps its layout. Without allow-same-origin or
// scripts the frame cannot be measured, so it keeps its fixed height (docs/M4-mailbox.md).
export const NARROW_FRAME_STYLE =
  "<style>pre{white-space:pre-wrap}@media (max-width:640px){" +
  "body *{max-width:100%!important;min-width:0!important;box-sizing:border-box}" +
  "table{table-layout:fixed}td,th{width:auto!important}img,video{height:auto!important}}</style>";

/**
 * The frame document: the CSP first, then no referrer, then a light page whatever the app
 * theme is, because senders design mail for a white background. Dark reading adds one more
 * inline style; it changes neither the CSP nor the sandbox.
 */
export function frameSrcdoc(body: string, remoteImages: boolean, darkReading = false): string {
  return [
    "<!doctype html><html><head>",
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(remoteImages)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta charset="utf-8">',
    "<style>:root{color-scheme:light}body{margin:0;padding:1em;background:white;color:black;",
    "font-family:system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>",
    NARROW_FRAME_STYLE,
    darkReading ? DARK_READING_STYLE : "",
    `</head><body>${body}</body></html>`,
  ].join("");
}
